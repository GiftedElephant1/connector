import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.ts';

const key = Buffer.alloc(32, 17);
const account = { accountName: 'Example account', accountId: '123', resources: [] };

test('authenticated encryption binds ciphertext to its purpose and detects tampering', (t) => {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  const input = { accessToken: 'private-access-token', refreshToken: 'private-refresh-token' };
  const first = store.seal(input, 'credential:openai');
  const second = store.seal(input, 'credential:openai');
  assert.notEqual(first, second, 'each encryption must use a fresh nonce');
  assert.deepEqual(store.open(first, 'credential:openai'), input);
  assert.throws(() => store.open(first, 'credential:anthropic'));
  const parts = first.split('.');
  const body = Buffer.from(parts[2], 'base64url');
  body[0] ^= 1;
  parts[2] = body.toString('base64url');
  assert.throws(() => store.open(parts.join('.'), 'credential:openai'));
  const wrongKey = new Store(':memory:', Buffer.alloc(32, 18));
  t.after(() => wrongKey.close());
  assert.throws(() => wrongKey.open(first, 'credential:openai'));
});

test('database and journal do not contain raw credentials, sessions, or OAuth verifiers', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'connector-store-'));
  const path = join(directory, 'connector.sqlite');
  const store = new Store(path, key);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const credential = { accessToken: 'private-access-token-plaintext', refreshToken: 'private-refresh-token-plaintext', fields: { secret: 'private-field-plaintext' } };
  const session = store.createSession();
  const state = 'private-oauth-state-plaintext';
  const verifier = 'private-oauth-verifier-plaintext';
  store.save('openai', credential, account);
  store.saveOAuth(state, session, 'openai', verifier);
  assert.deepEqual(store.credential('openai'), credential);
  // Windows does not expose POSIX owner/group permissions through stat().
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const file of readdirSync(directory)) {
    const content = readFileSync(join(directory, file));
    for (const secret of [credential.accessToken, credential.refreshToken, credential.fields.secret, session, state, verifier]) {
      assert.equal(content.includes(Buffer.from(secret)), false, `${file} contains a raw secret`);
    }
  }
  assert.equal(JSON.stringify(store.connection('openai')).includes(credential.accessToken), false);
});

test('sessions expire after 12 hours and logout removes pending OAuth flows', (t) => {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);
  const token = store.createSession();
  assert.equal(store.validSession(token), true);
  assert.equal(store.validSession('invalid'), false);
  clock.mock.mockImplementation(() => now + 12 * 60 * 60 * 1000);
  assert.equal(store.validSession(token), false);
  const active = store.createSession();
  store.saveOAuth('state', active, 'oauth', 'verifier');
  store.deleteSession(active);
  assert.equal(store.validSession(active), false);
  assert.equal(store.takeOAuth('state', active, 'oauth'), null);
});

test('OAuth state is bound to its session and provider, single use, and expires after 10 minutes', (t) => {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);
  const session = store.createSession();
  store.saveOAuth('state', session, 'oauth', 'verifier');
  assert.equal(store.takeOAuth('state', 'another-session', 'oauth'), null);
  assert.equal(store.takeOAuth('state', session, 'another-provider'), null);
  assert.deepEqual(store.takeOAuth('state', session, 'oauth'), { verifier: 'verifier' });
  assert.equal(store.takeOAuth('state', session, 'oauth'), null);
  store.saveOAuth('expired-state', session, 'oauth', 'verifier');
  clock.mock.mockImplementation(() => now + 10 * 60 * 1000);
  assert.equal(store.takeOAuth('expired-state', session, 'oauth'), null);
});

test('verification failures preserve credentials and disconnect removes both secret and summary', (t) => {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  const credential = { accessToken: 'test-access-token' };
  const before = store.save('openai', credential, account);
  store.markError('openai', 'Reconnect this account.');
  assert.deepEqual(store.credential('openai'), credential);
  assert.deepEqual(store.connection('openai'), { ...before, status: 'error', error: 'Reconnect this account.' });
  store.disconnect('openai');
  assert.equal(store.credential('openai'), null);
  assert.equal(store.connection('openai'), null);
});
