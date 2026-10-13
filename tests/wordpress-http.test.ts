import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { LookupAddress } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createWordPressRequest, normalizeWordPressSite, publicWordPressAddress } from '../server/wordpress-http.ts';
import { ProviderError, type Credential } from '../server/provider-types.ts';

const credential: Credential = {
  accessToken: 'abcd efgh ijkl mnop',
  fields: { siteUrl: 'https://example.com/blog/', username: 'publisher' },
};
const publicAnswer = { address: '93.184.216.34', family: 4 };

type ResponseStream = PassThrough & { statusCode: number };
type FakeRequest = EventEmitter & { destroyed: boolean; destroy: () => void; end: (body?: string) => void };

function fixture(options: {
  addresses?: LookupAddress[];
  lookupError?: Error;
  status?: number;
  response?: (incoming: ResponseStream, outgoing: FakeRequest) => void;
} = {}) {
  const resolutions: string[] = [];
  const calls: { url: URL; options: RequestOptions; body?: string; incoming: ResponseStream; outgoing: FakeRequest }[] = [];
  const lookup = async (hostname: string) => {
    resolutions.push(hostname);
    if (options.lookupError) throw options.lookupError;
    return options.addresses ?? [publicAnswer];
  };
  const request = ((url: URL, requestOptions: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const incoming = Object.assign(new PassThrough(), { statusCode: options.status ?? 200 });
    const outgoing = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() { this.destroyed = true; incoming.destroy(); },
      end(body?: string) {
        call.body = body;
        queueMicrotask(() => {
          callback(incoming as unknown as IncomingMessage);
          if (options.response) options.response(incoming, outgoing);
          else if (!incoming.destroyed) incoming.end(JSON.stringify({ id: 42, name: 'Publisher' }));
        });
      },
    });
    const call = { url, options: requestOptions, body: undefined as string | undefined, incoming, outgoing };
    calls.push(call);
    return outgoing;
  }) as unknown as typeof https.request;
  return { json: createWordPressRequest({ lookup, request }), calls, resolutions };
}

test('WordPress rejects private, local, mapped, special-use, and documentation addresses', () => {
  for (const address of [
    '0.0.0.0', '0.1.2.3', '10.1.2.3', '127.0.0.1', '100.64.0.1', '100.127.255.254',
    '169.254.169.254', '172.16.0.1', '172.31.255.254', '192.168.1.1', '192.0.0.8',
    '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.254', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fd00::1',
    'fe80::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:0808:0808::1',
    '64:ff9b::808:808', '3fff::1', 'not-an-ip',
  ]) assert.equal(publicWordPressAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(publicWordPressAddress(address), true, address);
  }
});

test('WordPress site normalization allows public HTTPS subdirectories and rejects ambiguous destinations', () => {
  assert.equal(normalizeWordPressSite('https://Example.com:443/blog///'), 'https://example.com/blog');
  assert.equal(normalizeWordPressSite('https://example.com'), 'https://example.com');
  assert.equal(normalizeWordPressSite('https://[2606:4700:4700::1111]/blog'), 'https://[2606:4700:4700::1111]/blog');
  for (const site of [
    'http://example.com', 'ftp://example.com', 'https://example.com:8443', 'https://user:secret@example.com',
    'https://example.com/?secret=value', 'https://example.com/#fragment', 'https://localhost',
    'https://service.local', 'https://service.internal', 'https://printer', 'https://127.0.0.1',
    'https://2130706433', 'https://0x7f000001', 'https://0177.0.0.1', 'https://[::1]',
    'https://[::ffff:127.0.0.1]', 'https://example.com/blog%2fsecret', 'https://example.com/%2e%2e/blog',
    'https://example.com/%00', 'https://example.com/white space', 'https://example.com/\\private',
  ]) assert.throws(() => normalizeWordPressSite(site), ProviderError, site);
});

test('WordPress blocks every mixed or private DNS answer before sending credentials', async () => {
  for (const addresses of [
    [], [{ address: '10.0.0.1', family: 4 }],
    [publicAnswer, { address: '169.254.169.254', family: 4 }],
    [{ address: '2606:4700:4700::1111', family: 6 }, { address: 'fd00::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
  ]) {
    const f = fixture({ addresses });
    await assert.rejects(f.json(credential, '/wp/v2/users/me'), /public internet address/);
    assert.equal(f.calls.length, 0);
  }
});

test('WordPress pins its single DNS resolution for IPv4 and IPv6 TLS lookups', async () => {
  for (const address of [publicAnswer, { address: '2606:4700:4700::1111', family: 6 }]) {
    const f = fixture({ addresses: [address] });
    await f.json(credential, '/wp/v2/users/me');
    assert.deepEqual(f.resolutions, ['example.com']);
    assert.equal(f.calls[0].url.hostname, 'example.com', 'The TLS connection retains the original host identity.');
    assert.equal(f.calls[0].options.agent, false, 'No pooled or proxy agent may bypass the pinned lookup.');
    assert.notEqual(f.calls[0].options.rejectUnauthorized, false);
    const pinned = f.calls[0].options.lookup as unknown as (hostname: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void;
    let answer: unknown[] = [];
    pinned('example.com', { all: false }, (...args) => { answer = args; });
    assert.deepEqual(answer, [null, address.address, address.family]);
    pinned('example.com', { all: true }, (...args) => { answer = args; });
    assert.deepEqual(answer, [null, [address]]);
    assert.deepEqual(f.resolutions, ['example.com'], 'Connecting cannot trigger a second DNS answer.');
  }
});

test('WordPress sends protected Application Password authentication and bounded JSON to the configured subdirectory', async () => {
  const f = fixture();
  const body = JSON.stringify({ title: 'Example', content: '<p>Content</p>' });
  assert.deepEqual(await f.json(credential, '/wp/v2/posts', {
    method: 'POST', body, headers: { authorization: 'Bearer attacker-controlled', host: 'private.internal', 'x-forwarded-host': 'private.internal' },
  }), { id: 42, name: 'Publisher' });
  assert.equal(f.calls[0].url.href, 'https://example.com/blog/wp-json/wp/v2/posts');
  assert.equal(f.calls[0].body, body);
  assert.deepEqual(f.calls[0].options.headers, {
    accept: 'application/json',
    authorization: `Basic ${Buffer.from('publisher:abcdefghijklmnop').toString('base64')}`,
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
  });
});

test('WordPress rejects unsupported methods, paths, malformed credentials, and oversized request bodies', async () => {
  for (const input of [
    { path: '/wp/v2/../users', init: {} }, { path: '//attacker.example/wp/v2/posts', init: {} },
    { path: '/wp/v2/users/1', init: {} }, { path: '/wp/v2/posts', init: { method: 'DELETE' } },
    { path: '/wp/v2/posts?value=one\r\nInjected: yes', init: {} },
    { path: '/wp/v2/posts', init: { method: 'POST', body: new URLSearchParams({ content: 'value' }) } },
    { path: '/wp/v2/posts', init: { method: 'POST', body: 'x'.repeat(1_000_001) } },
  ]) {
    const f = fixture();
    await assert.rejects(f.json(credential, input.path, input.init), ProviderError);
    assert.equal(f.calls.length, 0);
  }
  for (const invalid of [
    { ...credential, fields: { ...credential.fields, username: 'publisher:other' } },
    { ...credential, accessToken: 'password\r\nsecret' },
    { ...credential, accessToken: '' },
  ]) {
    const f = fixture();
    await assert.rejects(f.json(invalid, '/wp/v2/users/me'), ProviderError);
    assert.equal(f.calls.length, 0);
  }
});

test('WordPress never follows redirects or drains rejected responses and safely handles late stream errors', async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 404, 429, 500]) {
    const f = fixture({ status, response: incoming => {
      assert.equal(incoming.destroyed, true, 'Rejected responses must close even if an upstream never finishes its body.');
      assert.doesNotThrow(() => incoming.emit('error', new Error('private upstream body and application password')));
      incoming.emit('aborted');
    } });
    await assert.rejects(f.json(credential, '/wp/v2/users/me'), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes('private upstream'), false);
      assert.equal(error.message.includes(credential.accessToken), false);
      return true;
    });
    assert.equal(f.calls.length, 1, 'The transport must not issue a redirect request.');
  }
});

test('WordPress redacts DNS, transport, invalid JSON, and response-stream errors', async () => {
  const dns = fixture({ lookupError: new Error('secret-in-dns-error') });
  const fixtures = [
    dns,
    fixture({ response: incoming => incoming.end('secret-in-invalid-json') }),
    fixture({ response: incoming => incoming.destroy(new Error('secret-in-stream-error')) }),
    fixture({ response: (_incoming, outgoing) => outgoing.emit('error', new Error('secret-in-transport-error')) }),
  ];
  for (const f of fixtures) {
    await assert.rejects(f.json(credential, '/wp/v2/users/me'), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 502);
      assert.equal(error.message.includes('secret-in-'), false);
      return true;
    });
  }
  assert.equal(dns.calls.length, 0);
});

test('WordPress stops a response when it exceeds five megabytes', async () => {
  const f = fixture({ response: incoming => {
    incoming.write(Buffer.alloc(3_000_000, 'x'));
    incoming.write(Buffer.alloc(2_000_001, 'x'));
  } });
  await assert.rejects(f.json(credential, '/wp/v2/posts'), error => error instanceof ProviderError && error.status === 502);
  assert.equal(f.calls[0].outgoing.destroyed, true);
  assert.equal(f.calls[0].incoming.destroyed, true);
});
