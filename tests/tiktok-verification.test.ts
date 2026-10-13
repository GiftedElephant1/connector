import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { Store } from '../server/store.ts';
import { TikTokVerification } from '../server/tiktok-verification.ts';

const template: AppConfig = { origin: 'https://connector.example', host: '127.0.0.1', port: 3000, password: 'owner-test-password', encryptionKey: Buffer.alloc(32, 7), databasePath: ':memory:', secureCookies: true };
function service(t: TestContext) {
  const config = { ...template };
  const store = new Store(':memory:', config.encryptionKey);
  t.after(() => store.close());
  return { config, store, verification: new TikTokVerification(config, store) };
}
async function fixture(t: TestContext) {
  const config = { ...template };
  const store = new Store(':memory:', config.encryptionKey);
  const app = createApp(config, store, undefined, {});
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init);
  const mutate = (body: unknown, cookie = '', method = 'PUT', headers: Record<string, string> = {}) => request('/api/tiktok/verification', { method, headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify({ password: config.password }) });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  return { config, store, request, mutate, login };
}

test('TikTok verification keeps one exact file and uses the current configured origin', t => {
  const { verification, config, store } = service(t);
  assert.deepEqual(verification.status(), { filename: null, publicUrl: null });
  assert.equal(verification.content('tiktok123.txt'), null);
  const saved = verification.save({ filename: 'tiktokAbc_-123.txt', content: '\uFEFFverification=abc\r\n' });
  assert.deepEqual(saved, { filename: 'tiktokAbc_-123.txt', publicUrl: 'https://connector.example/tiktokAbc_-123.txt' });
  assert.equal(verification.content('tiktokAbc_-123.txt'), '\uFEFFverification=abc\r\n');
  assert.equal(verification.content('tiktokabc_-123.txt'), null);
  config.origin = 'https://new-tunnel.example';
  assert.equal(new TikTokVerification(config, store).status().publicUrl, 'https://new-tunnel.example/tiktokAbc_-123.txt');
  verification.save({ filename: 'tiktokReplacement.txt', content: 'replacement' });
  assert.equal(verification.content('tiktokAbc_-123.txt'), null);
  assert.deepEqual(verification.remove(), { filename: null, publicUrl: null });
  assert.equal(verification.content('tiktokReplacement.txt'), null);
});

test('TikTok verification rejects paths, private filenames, unsafe content and partial mutations', t => {
  const { verification } = service(t);
  const saved = verification.save({ filename: 'tiktok123.txt', content: 'original' });
  for (const filename of ['.env', 'connector.sqlite', '../tiktok123.txt', '/tiktok123.txt', 'C:\\tiktok123.txt', 'tiktok123.txt/../.env', 'tiktok123.txt:secret', 'tiktok123.html', 'tiktok123.txt\n', 'tiktok' + 'x'.repeat(101) + '.txt', 'TIKTOK123.txt', 'tiktok%2fsecret.txt']) {
    assert.throws(() => verification.save({ filename, content: 'changed' }), filename);
    assert.equal(verification.content(filename), null);
  }
  for (const content of ['', 'bad\0text', 'x'.repeat(16_385), '😀'.repeat(4097), '\uD800', null, 42]) assert.throws(() => verification.save({ filename: 'tiktok123.txt', content }));
  for (const value of [null, [], 'text', {}, { filename: 'tiktok123.txt' }, { filename: 'tiktok123.txt', content: 'changed', path: '.env' }]) assert.throws(() => verification.save(value));
  assert.deepEqual(verification.status(), saved);
  assert.equal(verification.content('tiktok123.txt'), 'original');
  verification.save({ filename: 'tiktok.txt', content: '😀'.repeat(4096) });
  assert.equal(Buffer.byteLength(verification.content('tiktok.txt')!, 'utf8'), 16_384);
});

test('TikTok verification public route serves exact UTF-8 bytes as text and deletion returns 404', async t => {
  const f = await fixture(t);
  const filename = 'tiktokReview_42.txt';
  const initial = await f.request(`/${filename}`);
  assert.equal(initial.status, 404);
  assert.match(initial.headers.get('content-type')!, /text\/plain/);
  const content = '\uFEFF<script>alert("not HTML")</script>\r\nverification=✓\n';
  const cookie = await f.login();
  assert.equal((await f.mutate({ filename, content }, cookie)).status, 200);
  const response = await f.request(`/${filename}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(content, 'utf8'));
  assert.equal((await f.request('/tiktokDifferent.txt')).status, 404);
  f.store.writeSetting('unrelated-private-data', { keep: 'private' });
  const removed = await f.mutate(undefined, cookie, 'DELETE');
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { filename: null, publicUrl: null });
  assert.equal((await f.request(`/${filename}`)).status, 404);
  assert.deepEqual(f.store.readSetting('unrelated-private-data'), { keep: 'private' });
});

test('TikTok verification settings enforce owner authentication and CSRF for upload and removal', async t => {
  const f = await fixture(t);
  const input = { filename: 'tiktok123.txt', content: 'public-verification' };
  assert.equal((await f.request('/api/tiktok/verification')).status, 401);
  for (const method of ['PUT', 'DELETE']) assert.equal((await f.mutate(input, '', method)).status, 401);
  const cookie = await f.login();
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await f.request('/api/tiktok/verification', { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await f.mutate(input, cookie, method, { origin: 'https://attacker.example' })).status, 403);
  }
  assert.equal((await f.mutate(input, cookie)).status, 200);
  const status = await f.request('/api/tiktok/verification', { headers: { cookie } });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await status.json(), { filename: input.filename, publicUrl: `https://connector.example/${input.filename}` });
  assert.equal((await f.mutate({ filename: '.env', content: 'do-not-store' }, cookie)).status, 400);
  assert.equal(await (await f.request('/tiktok123.txt')).text(), input.content);
});
