import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { test } from 'node:test';
import { isPublicBrowserAddress, startBrowserProxy, validateBrowserUrl, type BrowserProxy } from '../server/browser-network';
import { ProviderError } from '../server/provider-types';

const authorization = (proxy: BrowserProxy) => `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
async function tunnel(proxy: BrowserProxy, target: string, auth: string | false = authorization(proxy)): Promise<{ status: number; socket: Duplex; head: Buffer }> {
  const url = new URL(proxy.server);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, method: 'CONNECT', path: target,
      headers: auth === false ? {} : { 'Proxy-Authorization': auth }, timeout: 3000 });
    req.on('connect', (res, socket, head) => resolve({ status: res.statusCode!, socket, head }));
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Test proxy request timed out')));
    req.end();
  });
}
async function echoServer() {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    dial: () => connect({ host: '127.0.0.1', port: address.port }),
    close: async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

test('browser network accepts global addresses and blocks private, reserved and IP transition ranges', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450:400e:80d::200e']) {
    assert.equal(isPublicBrowserAddress(address), true, address);
  }
  for (const address of ['0.0.0.0', '0.1.2.3', '10.1.1.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.254', '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.254',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::808:808', '64:ff9b:1::8', '100::1', '2001::1', '2001:20::1',
    '2001:db8::1', '2002:7f00:1::1', '3fff:1::1', 'fc00::1', 'fd00::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', 'not-an-ip']) {
    assert.equal(isPublicBrowserAddress(address), false, address);
  }
});

test('browser URL validation rejects alternate local IP spellings, credentials, non-HTTPS and reserved hosts', () => {
  assert.equal(validateBrowserUrl('https://EXAMPLE.com:443/sign-in?next=%2F#section'), 'https://example.com/sign-in?next=%2F#section');
  assert.equal(validateBrowserUrl('https://[2001:4860:4860::8888]/'), 'https://[2001:4860:4860::8888]/');
  for (const url of ['http://example.com', 'file:///etc/passwd', 'data:text/html,hello', 'https://user:secret@example.com',
    'https://example.com:8443', 'https://localhost/', 'https://LOCALHOST./', 'https://service.local/', 'https://service.internal/',
    'https://router/', 'https://example.test/', 'https://example.com./', 'https://example.com\\@127.0.0.1',
    'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/',
    'https://[::ffff:127.0.0.1]/', 'https://169.254.169.254/', 'https://[fc00::1]/', 'https://example.com\n/',
    ' https://example.com/', 'https://not_a_host.example.com', 'https://example.com:0/']) {
    assert.throws(() => validateBrowserUrl(url), ProviderError, url);
  }
});

test('browser proxy requires authentication before resolving or connecting and rejects HTTP forwarding', { timeout: 5000 }, async () => {
  let resolutions = 0;
  const proxy = await startBrowserProxy({ resolve: async () => { resolutions++; return [{ address: '1.1.1.1', family: 4 }]; } });
  try {
    for (const auth of [false, 'Basic wrong'] as const) {
      const result = await tunnel(proxy, 'example.com:443', auth);
      assert.equal(result.status, 407);
      result.socket.destroy();
    }
    assert.equal(resolutions, 0);
    const url = new URL(proxy.server);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: url.hostname, port: url.port, path: 'http://example.com/', headers: { 'Proxy-Authorization': authorization(proxy) } }, res => {
        res.resume(); resolve(res.statusCode!);
      });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
    assert.equal(resolutions, 0);
  } finally { await proxy.close(); }
});

test('browser tools cannot browse the 1Password vault website through URLs or proxy tunnels', async () => {
  let resolutions = 0;
  const proxy = await startBrowserProxy({ resolve: async () => { resolutions++; return []; } });
  try {
    for (const host of ['1password.com', 'my.1password.com', 'TEAM.1PASSWORD.COM', '1password.eu', 'team.1password.eu', '1password.ca', 'team.1password.ca']) {
      assert.throws(() => validateBrowserUrl(`https://${host}/`), /vault websites are unavailable/);
      const result = await tunnel(proxy, `${host}:443`);
      assert.equal(result.status, 403, host); result.socket.destroy();
    }
    assert.equal(resolutions, 0);
    for (const host of ['1password.dev', 'support.1password.dev', '1password.com.example.org', 'my1password.com']) {
      assert.equal(validateBrowserUrl(`https://${host}/`), `https://${host}/`);
    }
  } finally { await proxy.close(); }
});

test('browser proxy refuses malformed CONNECT destinations and forbidden literal addresses before DNS', { timeout: 5000 }, async () => {
  let resolutions = 0;
  const proxy = await startBrowserProxy({ resolve: async () => { resolutions++; return []; } });
  try {
    for (const target of ['example.com:80', 'example.com:8443', 'example.com:443/path', 'user@example.com:443', '127.0.0.1:443',
      '[::ffff:127.0.0.1]:443', '[2001:db8::1]:443', 'localhost:443', 'example.com.:443']) {
      const result = await tunnel(proxy, target);
      assert.equal(result.status, 403, target);
      result.socket.destroy();
    }
    assert.equal(resolutions, 0);
  } finally { await proxy.close(); }
});

test('browser proxy rejects the entire DNS answer if any address is nonpublic or malformed', { timeout: 5000 }, async () => {
  let dialed = false;
  let records: { address: string; family: number }[] = [];
  const proxy = await startBrowserProxy({ resolve: async () => records, connect: () => { dialed = true; throw new Error('Must not dial'); } });
  try {
    for (records of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '1.1.1.1', family: 4 }, { address: 'fd00::1', family: 6 }],
      [{ address: '1.1.1.1', family: 6 }], [{ address: 'host.example.com', family: 4 }],
      [{ address: '2001:4860::1', family: 6 }, { address: '169.254.169.254', family: 4 }]]) {
      const result = await tunnel(proxy, 'example.com:443');
      assert.equal(result.status, 403);
      result.socket.destroy();
    }
    assert.equal(dialed, false);
  } finally { await proxy.close(); }
});

test('browser proxy pins verified numeric addresses, prefers usable IPv4, and revalidates each new DNS answer', { timeout: 5000 }, async () => {
  const upstream = await echoServer();
  const calls: { address: string; family: number }[] = [];
  let lookups = 0;
  const proxy = await startBrowserProxy({
    resolve: async host => {
      assert.equal(host, 'example.com');
      lookups++;
      return lookups === 1 ? [{ address: '2606:4700:4700::1111', family: 6 }, { address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
    },
    connect: (address, family) => { calls.push({ address, family }); return upstream.dial(); },
  });
  try {
    const first = await tunnel(proxy, 'example.com:443');
    assert.equal(first.status, 200);
    const received = once(first.socket, 'data');
    first.socket.write('opaque-TLS-payload');
    assert.equal((await received)[0].toString(), 'opaque-TLS-payload');
    assert.deepEqual(calls, [{ address: '93.184.216.34', family: 4 }]);
    const second = await tunnel(proxy, 'example.com:443');
    assert.equal(second.status, 403);
    assert.equal(calls.length, 1);
    assert.equal(lookups, 2);
    first.socket.destroy(); second.socket.destroy();
  } finally { await proxy.close(); await upstream.close(); }
});

test('browser proxy does not resolve public IP literals and closes active tunnels on shutdown', { timeout: 5000 }, async () => {
  const upstream = await echoServer();
  let resolved = false;
  const proxy = await startBrowserProxy({
    resolve: async () => { resolved = true; return []; },
    connect: (address, family) => { assert.equal(address, '1.1.1.1'); assert.equal(family, 4); return upstream.dial(); },
  });
  try {
    const result = await tunnel(proxy, '1.1.1.1:443');
    assert.equal(result.status, 200);
    assert.equal(resolved, false);
    const finished = once(result.socket, 'close');
    result.socket.resume();
    await proxy.close();
    await finished;
    await proxy.close();
  } finally { await proxy.close(); await upstream.close(); }
});

test('browser proxy suppresses resolver details and never dials after shutdown during DNS', { timeout: 5000 }, async () => {
  const privateDiagnostic = 'TEST-PRIVATE-LOOKUP-DIAGNOSTIC';
  const failing = await startBrowserProxy({ resolve: async () => { throw new Error(privateDiagnostic); } });
  try {
    const result = await tunnel(failing, 'example.com:443');
    assert.equal(result.status, 502);
    assert.equal(result.head.toString().includes(privateDiagnostic), false);
    result.socket.destroy();
  } finally { await failing.close(); }

  let resolveLookup!: (records: { address: string; family: number }[]) => void;
  let notifyLookup!: () => void;
  const started = new Promise<void>(resolve => { notifyLookup = resolve; });
  let dialed = false;
  const proxy = await startBrowserProxy({
    resolve: () => { notifyLookup(); return new Promise(resolve => { resolveLookup = resolve; }); },
    connect: () => { dialed = true; throw new Error('Must not dial'); },
  });
  const pending = tunnel(proxy, 'example.com:443').catch(() => undefined);
  await started;
  await proxy.close();
  resolveLookup([{ address: '1.1.1.1', family: 4 }]);
  await pending;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(dialed, false);
});
