import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { ProviderError, type Credential } from './provider-types';

const unavailable = () => new ProviderError('WordPress could not complete the request. If you submitted a change, check your site before trying again.', 502);
const invalidSite = () => new ProviderError('Enter the public HTTPS address of your WordPress site, such as https://example.com or https://example.com/blog.');

export function publicWordPressAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    // Restrict to global unicast. Exclude translation/tunnelling, special-use,
    // documentation and local ranges; mapped IPv4 cannot bypass the IPv4 check.
    const [first, second = '0'] = address.toLowerCase().split(':');
    const a = parseInt(first, 16), b = parseInt(second || '0', 16);
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && a !== 0x3fff &&
      !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
  }
  return false;
}

export function normalizeWordPressSite(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidSite(); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || !host.includes('.') && !isIP(host) ||
      /(?:^|\.)(?:localhost|local|internal)$/i.test(host) || (isIP(host) && !publicWordPressAddress(host)) ||
      /[\\\s]/.test(value) || /%(?:2f|5c|2e|00)/i.test(value)) throw invalidSite();
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

type Dependencies = {
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  request?: typeof https.request;
};

export function createWordPressRequest(dependencies: Dependencies = {}) {
  const lookup = dependencies.lookup || (hostname => dns.lookup(hostname, { all: true, verbatim: true }));
  const request = dependencies.request || https.request;
  return async (credential: Credential, path: string, init: RequestInit = {}): Promise<unknown> => {
    const site = normalizeWordPressSite(credential.fields?.siteUrl || '');
    const username = credential.fields?.username || '';
    const password = credential.accessToken;
    if (!username.trim() || username.length > 250 || /[:\r\n\0]/.test(username) ||
        typeof password !== 'string' || !password.trim() || password.length > 1024 || /[\r\n\0]/.test(password)) {
      throw new ProviderError('Enter your WordPress username and an Application Password from your WordPress profile.');
    }
    if (!/^\/wp\/v2\/(?:users\/me|posts(?:\/\d+)?|pages(?:\/\d+)?)(?:\?[^#\\]*)?$/.test(path) ||
        /[\r\n]/.test(path) || !['GET', 'POST'].includes(init.method || 'GET') ||
        (init.body !== undefined && typeof init.body !== 'string')) throw new ProviderError('That WordPress request is not supported.');
    const endpoint = new URL(`${site}/wp-json${path}`);
    let addresses: LookupAddress[];
    let lookupDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        lookup(endpoint.hostname.replace(/^\[|\]$/g, '')),
        new Promise<never>((_resolve, reject) => {
          lookupDeadline = setTimeout(() => reject(unavailable()), 10_000);
          lookupDeadline.unref();
        }),
      ]);
    } catch { throw unavailable(); }
    finally { clearTimeout(lookupDeadline); }
    if (!addresses.length || addresses.some(item => !publicWordPressAddress(item.address))) {
      throw new ProviderError('WordPress must resolve to a public internet address. Private or local network sites are not supported.');
    }
    // Resolve once and pin that answer on the actual TLS connection. Do not use
    // fetch(), a proxy, redirects, or a pooled socket that could bypass this check.
    const address = addresses[0];
    const body = typeof init.body === 'string' ? init.body : undefined;
    if (body && Buffer.byteLength(body) > 1_000_000) throw new ProviderError('The WordPress request is too large.');
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error); else resolve(value);
      };
      try {
        const outgoing = request(endpoint, {
          method: init.method || 'GET', agent: false,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
          headers: {
            accept: 'application/json',
            authorization: `Basic ${Buffer.from(`${username}:${password.replace(/ /g, '')}`).toString('base64')}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          },
        }, incoming => {
          incoming.on('error', () => finish(unavailable()));
          incoming.on('aborted', () => finish(unavailable()));
          const status = incoming.statusCode || 502;
          if (status < 200 || status >= 300) {
            if (status === 401) finish(new ProviderError('WordPress rejected this Application Password. Check your username and create a new Application Password in your profile.', 401));
            else if (status === 403) finish(new ProviderError('Your WordPress user cannot perform this action. Check its role and permissions.', 403));
            else if (status === 400 || status === 404) finish(new ProviderError('WordPress rejected the request. Check the site address, content ID, and submitted fields.', status));
            else if (status === 429) finish(new ProviderError('WordPress is rate limiting requests. Try again later.', 429));
            else finish(unavailable());
            // Reject redirects and error bodies without draining an unbounded
            // response after finish() clears the request deadline.
            incoming.destroy();
            return;
          }
          let bytes = 0;
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 5_000_000) { finish(unavailable()); outgoing.destroy(); return; }
            chunks.push(Buffer.from(chunk));
          });
          incoming.on('end', () => {
            try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { finish(unavailable()); }
          });
        });
        outgoing.on('error', () => finish(unavailable()));
        deadline = setTimeout(() => { finish(unavailable()); outgoing.destroy(); }, 15_000);
        deadline.unref();
        outgoing.end(body);
      } catch { finish(unavailable()); }
    });
  };
}

export const wordpressJson = createWordPressRequest();
