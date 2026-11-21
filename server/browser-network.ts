import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { ProviderError } from './provider-types';

const INVALID_URL = 'Use a public HTTPS website on port 443. Local network addresses and other protocols are unavailable in the AI browser.';
const MAX_CONNECTIONS = 64;
const DNS_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 120_000;
const MAX_TUNNEL_MS = 10 * 60_000;

/** Conservative global-unicast allowlist, including denial of IP transition ranges. */
export function isPublicBrowserAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    // Every allowed address has an explicit first group. IPv4-mapped/translated,
    // NAT64, loopback, link-local, unique-local and multicast are outside 2000::/3.
    const [first, second] = address.toLowerCase().split(':').map(part => parseInt(part || '0', 16));
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
      !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) &&
      !(first === 0x3fff && second <= 0x0fff);
  }
  return false;
}

function hostname(value: string): string {
  const host = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  // Vault web pages can reveal unrelated stored secrets as ordinary text. Keep
  // credential use on the server-side CLI path, including after manual sign-in.
  if (/(?:^|\.)1password\.(?:com|eu|ca)$/i.test(host)) {
    throw new ProviderError('1Password vault websites are unavailable to browser tools. Use browser_sign_in to fill saved logins on their matching websites.');
  }
  if (isIP(host)) {
    if (!isPublicBrowserAddress(host)) throw new ProviderError(INVALID_URL);
    return host;
  }
  // Reject single-label names, reserved/local domains and ambiguous spellings.
  if (!host || host.length > 253 || host.endsWith('.') || !host.includes('.') ||
    host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example|onion|arpa)$/i.test(host)) {
    throw new ProviderError(INVALID_URL);
  }
  return host;
}

/** DNS is checked again, and its result pinned, for every proxy connection. */
export function validateBrowserUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) throw new ProviderError(INVALID_URL);
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError(INVALID_URL); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new ProviderError(INVALID_URL);
  hostname(url.hostname);
  return url.href;
}

interface ResolvedAddress { address: string; family: number }
/** Dependency injection is for deterministic tests; never sourced from owner/agent input. */
export interface BrowserProxyOptions {
  resolve?: (host: string) => Promise<readonly ResolvedAddress[]>;
  connect?: (address: string, family: 4 | 6) => Socket;
}
export interface BrowserProxy {
  server: string; username: string; password: string;
  close(): Promise<void>;
}

function deadline<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Lookup unavailable')), timeout);
    timer.unref();
    promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(new Error('Lookup unavailable')); });
  });
}

/** Authenticated loopback HTTPS tunnel. Destination DNS is never delegated to Chromium. */
export async function startBrowserProxy(options: BrowserProxyOptions = {}): Promise<BrowserProxy> {
  const username = randomBytes(18).toString('base64url');
  const password = randomBytes(32).toString('base64url');
  const expectedAuth = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  const sockets = new Set<Duplex>();
  let closed = false;
  const resolve = options.resolve || (host => lookup(host, { all: true, verbatim: true }));
  const dial = options.connect || ((address, family) => connect({ host: address, port: 443, family }));
  const authorized = (value: string | undefined) => {
    if (!value || value.length > 512) return false;
    const received = Buffer.from(value);
    return received.length === expectedAuth.length && timingSafeEqual(received, expectedAuth);
  };
  const reject = (socket: Duplex, status: 403 | 407 | 502 | 503) => {
    if (socket.destroyed) return;
    const label = status === 407 ? 'Proxy Authentication Required' : status === 403 ? 'Forbidden' : status === 503 ? 'Unavailable' : 'Bad Gateway';
    socket.end(`HTTP/1.1 ${status} ${label}\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="Connector browser"\r\n' : ''}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, (req, res) => {
    // Plain HTTP forwarding, absolute-form URLs and WebSocket upgrade requests
    // are never part of this proxy's public-HTTPS-only contract.
    const status = authorized(req.headers['proxy-authorization']) ? 403 : 407;
    res.writeHead(status, { Connection: 'close', 'Content-Length': '0', ...(status === 407 ? { 'Proxy-Authenticate': 'Basic realm="Connector browser"' } : {}) });
    res.end();
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on('connection', socket => {
    if (closed || sockets.size >= MAX_CONNECTIONS * 2) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => { socket.destroy(); });
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  server.on('upgrade', (_req, socket) => reject(socket, 403));
  server.on('connect', (req, client, head) => {
    if (!authorized(req.headers['proxy-authorization'])) { reject(client, 407); return; }
    // CONNECT's request target must be only a host and the fixed HTTPS port.
    if (!/^([a-z0-9.-]+|\[[a-f0-9:.]+\]):443$/i.test(req.url || '')) { reject(client, 403); return; }
    let host: string;
    try {
      const parsed = new URL(`https://${req.url}`);
      host = hostname(parsed.hostname);
    } catch { reject(client, 403); return; }
    client.pause();
    void (async () => {
      let records: readonly ResolvedAddress[];
      try {
        const family = isIP(host);
        records = family ? [{ address: host, family }] : await deadline(resolve(host), DNS_TIMEOUT_MS);
      } catch { reject(client, 502); return; }
      if (closed || client.destroyed) { client.destroy(); return; }
      if (!records.length || records.length > 64 || records.some(record =>
        !isPublicBrowserAddress(record.address) || isIP(record.address) !== record.family)) {
        reject(client, 403); return;
      }
      // A numeric address and explicit family prevent a second DNS lookup at
      // connection time. All returned records were checked before selecting one.
      // Prefer IPv4 when both families are available: some desktop networks
      // advertise IPv6 DNS records without providing a usable IPv6 route.
      const selected = records.find(record => record.family === 4) || records[0];
      let upstream: Socket;
      try { upstream = dial(selected.address, selected.family as 4 | 6); }
      catch { reject(client, 502); return; }
      sockets.add(upstream);
      let connected = false;
      const connectTimer = setTimeout(() => { reject(client, 502); upstream.destroy(); }, CONNECT_TIMEOUT_MS);
      const lifeTimer = setTimeout(() => { client.destroy(); upstream.destroy(); }, MAX_TUNNEL_MS);
      connectTimer.unref(); lifeTimer.unref();
      upstream.setTimeout(IDLE_TIMEOUT_MS, () => { client.destroy(); upstream.destroy(); });
      upstream.on('error', () => {
        if (!connected) reject(client, 502); else client.destroy();
        upstream.destroy();
      });
      upstream.on('close', () => {
        sockets.delete(upstream); clearTimeout(connectTimer); clearTimeout(lifeTimer);
        if (connected) client.destroy();
      });
      client.once('close', () => { clearTimeout(connectTimer); clearTimeout(lifeTimer); upstream.destroy(); });
      upstream.once('connect', () => {
        clearTimeout(connectTimer);
        if (closed || client.destroyed) { upstream.destroy(); return; }
        connected = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    })().catch(() => { reject(client, 502); });
  });
  try {
    await new Promise<void>((resolveStart, rejectStart) => {
      server.once('error', rejectStart);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', rejectStart); resolveStart(); });
    });
  } catch {
    closed = true;
    for (const socket of sockets) socket.destroy();
    server.close();
    throw new ProviderError('The private browser network could not start. Restart Connector and try again.', 503);
  }
  server.on('error', () => { closed = true; for (const socket of sockets) socket.destroy(); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new ProviderError('The private browser network could not start.', 503); }
  let closing: Promise<void> | undefined;
  return {
    server: `http://127.0.0.1:${address.port}`, username, password,
    close() {
      if (closing) return closing;
      closed = true;
      closing = new Promise(resolveClose => {
        server.close(() => resolveClose());
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
