import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { PublicTunnel, type TunnelDriver } from '../server/tunnel';
import type { AppConfig } from '../server/config';

const config: AppConfig = { origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, password: 'test-owner-password', encryptionKey: randomBytes(32), databasePath: ':memory:', secureCookies: false };
const token = 'ngrok_test_private_token_do_not_echo';

test('public access uses a fixed local upstream, persists encrypted credentials, and exposes only status', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'connector-tunnel-test-'));
  const path = join(directory, 'data.sqlite');
  const store = new Store(path, config.encryptionKey);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let closes = 0;
  let applied = '';
  const driver: TunnelDriver = { forward: async options => {
    assert.equal(options.addr, 'http://127.0.0.1:3000');
    assert.equal(options.authtoken, token);
    assert.equal(options.domain, 'owner.ngrok-free.app');
    return { url: () => 'https://owner.ngrok-free.app', close: async () => { closes++; } };
  } };
  const tunnel = new PublicTunnel({ ...config }, store, origin => { applied = origin; }, async () => driver);
  assert.equal(tunnel.snapshot().configured, false);
  const connected = await tunnel.start({ authtoken: token, domain: 'owner.ngrok-free.app' });
  assert.equal(applied, 'https://owner.ngrok-free.app');
  assert.equal(connected.status, 'running');
  assert.equal(JSON.stringify(connected).includes(token), false);
  assert.equal(store.readSetting<{ authtoken: string }>('public-tunnel')?.authtoken, token);
  for (const file of [path, `${path}-wal`]) assert.equal(readFileSync(file).includes(Buffer.from(token)), false);
  await assert.rejects(tunnel.start(), /Stop the current/);
  await tunnel.stop();
  assert.equal(closes, 1);
  assert.equal(tunnel.snapshot().autoStart, false);
  await tunnel.restore();
  assert.equal(tunnel.snapshot().status, 'stopped');
});

test('public access rejects malformed configuration and redacts SDK failure details', async t => {
  const store = new Store(':memory:', config.encryptionKey);
  t.after(() => store.close());
  let calls = 0;
  const tunnel = new PublicTunnel({ ...config }, store, () => {}, async () => ({ forward: async () => { calls++; throw new Error(`ERR_NGROK_105 invalid ${token}`); } }));
  await assert.rejects(tunnel.start(), /authtoken/);
  await assert.rejects(tunnel.start({ authtoken: token, domain: 'https://evil.example/path' }), /hostname/);
  await assert.rejects(tunnel.start({ authtoken: token, domain: 'localhost' }), /hostname/);
  await assert.rejects(tunnel.start({ authtoken: token, domain: '127.0.0.1' }), /hostname/);
  assert.equal(calls, 0);
  await assert.rejects(tunnel.start({ authtoken: token }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ERR_NGROK_105/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.equal(tunnel.snapshot().status, 'error');
  assert.equal(tunnel.snapshot().configured, false);
  assert.equal(JSON.stringify(tunnel.snapshot()).includes(token), false);
});

test('tunnel timeout closes a late listener and cannot persist an unconfirmed public URL', async t => {
  const store = new Store(':memory:', config.encryptionKey);
  t.after(() => store.close());
  let resolveOpening!: (value: { url(): string; close(): Promise<void> }) => void;
  let closes = 0;
  let changes = 0;
  const opening = new Promise<{ url(): string; close(): Promise<void> }>(resolve => { resolveOpening = resolve; });
  const tunnel = new PublicTunnel({ ...config }, store, () => { changes++; }, async () => ({ forward: () => opening }), 10);
  await assert.rejects(tunnel.start({ authtoken: token }), /Could not open public access/);
  resolveOpening({ url: () => 'https://late.ngrok-free.app', close: async () => { closes++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(changes, 0);
  assert.equal(tunnel.snapshot().configured, false);
});

test('saved enabled tunnel restores with the saved credential and graceful shutdown preserves preference', async t => {
  const store = new Store(':memory:', config.encryptionKey);
  t.after(() => store.close());
  let calls = 0;
  const driver: TunnelDriver = { forward: async options => {
    assert.equal(options.authtoken, token); calls++;
    return { url: () => 'https://owner.ngrok-free.app', close: async () => {} };
  } };
  const first = new PublicTunnel({ ...config }, store, () => {}, async () => driver);
  await first.start({ authtoken: token });
  await first.stop(true);
  const second = new PublicTunnel({ ...config }, store, () => {}, async () => driver);
  await second.restore();
  assert.equal(calls, 2);
  assert.equal(second.snapshot().status, 'running');
  await second.stop();
});
