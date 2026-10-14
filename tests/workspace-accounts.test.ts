import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, type TestContext } from 'node:test';
import { Store } from '../server/store';
import type { AppConfig } from '../server/config';
import { ProviderError } from '../server/provider-types';
import { WorkspaceAccounts } from '../server/workspace-accounts';
import { workspaceApps } from '../server/workspace-actions';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const key = Buffer.alloc(32, 21);
const google = { GOOGLE_CLIENT_ID: 'workspace-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'workspace-client-private' };
const scopesFor = (...apps: string[]) => ['openid', 'email', ...apps.flatMap(id => workspaceApps.find(app => app.id === id)!.scopes)].join(' ');
const config: AppConfig = { origin: 'https://connector.example', host: '127.0.0.1', port: 3000, password: 'correct-test-password', encryptionKey: key, databasePath: ':memory:', secureCookies: true };

function fixture(t: TestContext, path = ':memory:') {
  const store = new Store(path, key);
  t.after(() => store.close());
  const settings = { ...google };
  const appConfig = { ...config, databasePath: path };
  const service = new WorkspaceAccounts(appConfig, store, settings);
  const session = store.createSession();
  return { store, service, session, settings, config: appConfig };
}
type Fixture = ReturnType<typeof fixture>;
function oauthResponse(subject: string, apps = ['sheets'], refreshToken: string | undefined = `refresh-private-${subject}`, scopeOverride?: string) {
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (String(input) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: `access-private-${subject}`, refresh_token: refreshToken, expires_in: 3600, scope: scopeOverride ?? scopesFor(...apps) });
    assert.equal(String(input), 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer access-private-${subject}`);
    return Response.json({ sub: subject, email: `${subject}@example.com`, email_verified: true, name: subject });
  };
}
async function connect(f: Fixture, subject: string, apps = ['sheets'], expectedAccountId?: string) {
  const start = new URL(f.service.startOAuth(f.session, apps, expectedAccountId).url);
  oauthResponse(subject, apps);
  return f.service.finishOAuth(f.session, { state: start.searchParams.get('state'), code: `code-${subject}` });
}

test('Workspace OAuth uses session-bound single-use PKCE and only selected app scopes', async t => {
  const f = fixture(t);
  const url = new URL(f.service.startOAuth(f.session, ['sheets', 'tasks']).url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), `${config.origin}/api/workspace/google/callback`);
  assert.equal(url.searchParams.get('scope'), scopesFor('sheets', 'tasks'));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent select_account');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(url.searchParams.has('include_granted_scopes'), false);
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(init?.body as URLSearchParams);
      assert.equal(body.get('client_secret'), google.GOOGLE_CLIENT_SECRET);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'returned-code');
      assert.equal(body.get('redirect_uri'), url.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), url.searchParams.get('code_challenge'));
      return Response.json({ access_token: 'new-private-token', refresh_token: 'new-private-refresh', expires_in: 3600, scope: scopesFor('sheets', 'tasks') });
    }
    return Response.json({ sub: 'person1', email: 'person1@example.com', email_verified: true });
  };
  const input = { state: url.searchParams.get('state'), code: 'returned-code' };
  await assert.rejects(f.service.finishOAuth(f.store.createSession(), input), /another session/);
  assert.equal(requests, 0);
  const account = await f.service.finishOAuth(f.session, input);
  assert.deepEqual(account.apps, ['sheets', 'tasks']);
  assert.equal(requests, 2);
  await assert.rejects(f.service.finishOAuth(f.session, input), /expired/);
  assert.equal(requests, 2);
});

test('Google account additions preserve all other Google and existing platform credentials', async t => {
  const f = fixture(t);
  f.store.save('wordpress', { accessToken: 'wordpress-private-token' }, { accountName: 'Blog', resources: [] });
  const first = await connect(f, 'first', ['sheets', 'gmail']);
  const second = await connect(f, 'second', ['docs']);
  assert.notEqual(first.id, second.id);
  assert.match(first.id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.id.includes('first'), false);
  assert.deepEqual(f.service.listAccounts().map(account => account.email), ['first@example.com', 'second@example.com']);
  assert.equal((await f.service.getCredential(first.id)).accessToken, 'access-private-first');
  assert.equal((await f.service.getCredential(second.id)).accessToken, 'access-private-second');
  assert.equal(f.store.credential('wordpress')?.accessToken, 'wordpress-private-token');
});

test('reauthorizing one account rejects a different Google identity without replacing either account', async t => {
  const f = fixture(t);
  const first = await connect(f, 'first');
  const second = await connect(f, 'second', ['docs']);
  const url = new URL(f.service.startOAuth(f.session, ['tasks'], first.id).url);
  assert.equal(url.searchParams.get('login_hint'), first.email);
  assert.ok(url.searchParams.get('scope')!.includes('spreadsheets'));
  oauthResponse('second', ['sheets', 'tasks']);
  await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'wrong-identity-code' }), /different Google account/);
  assert.deepEqual(f.service.listAccounts().map(account => account.apps), [['sheets'], ['docs']]);
  assert.equal((await f.service.getCredential(first.id)).refreshToken, 'refresh-private-first');
  assert.equal((await f.service.getCredential(second.id)).refreshToken, 'refresh-private-second');
});

test('partial Google consent exposes only actual granted apps and blocks ungranted agent permissions', async t => {
  const f = fixture(t);
  const url = new URL(f.service.startOAuth(f.session, ['sheets', 'gmail']).url);
  oauthResponse('partial', ['sheets', 'gmail'], 'refresh-private-partial', scopesFor('sheets') + ' https://www.googleapis.com/auth/gmail.readonly');
  const account = await f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'partial-code' });
  assert.deepEqual(account.apps, ['sheets']);
  assert.deepEqual(account.missingApps, ['gmail']);
  assert.throws(() => f.service.createProfile({ name: 'Grok', bindings: [{ accountId: account.id, apps: ['gmail'] }] }), /Authorize the selected apps/);
  const profile = f.service.createProfile({ name: 'Grok', bindings: [{ accountId: account.id, apps: ['sheets'] }], defaultAccountId: account.id });
  assert.equal(f.service.authorize(profile.profile.id, 'sheets').email, account.email);
});

test('account refresh tokens are preserved only for the same verified identity and OAuth client', async t => {
  const f = fixture(t);
  const first = await connect(f, 'first');
  let url = new URL(f.service.startOAuth(f.session, ['tasks'], first.id).url);
  oauthResponse('first', ['sheets', 'tasks'], '');
  const updated = await f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'same-user-code' });
  assert.equal(updated.id, first.id);
  assert.equal((await f.service.getCredential(first.id)).refreshToken, 'refresh-private-first');
  assert.deepEqual(updated.apps, ['sheets', 'tasks']);
  assert.equal(f.service.listAccounts().length, 1);
  url = new URL(f.service.startOAuth(f.session, ['sheets']).url);
  oauthResponse('new', ['sheets'], '');
  await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'new-code' }), /offline access/);
  f.settings.GOOGLE_CLIENT_ID = 'different-client.apps.googleusercontent.com';
  url = new URL(f.service.startOAuth(f.session, ['sheets'], first.id).url);
  oauthResponse('first', ['sheets'], '');
  await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'different-client-code' }), /offline access/);
  assert.equal(f.service.listAccounts().length, 1);
});

test('OAuth denial, changed redirect settings, missing scope, and unverified email cannot create connections', async t => {
  const f = fixture(t);
  let url = new URL(f.service.startOAuth(f.session, ['sheets']).url);
  await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), error: 'access_denied' }), /declined/);
  await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'replay-code' }), /expired/);
  url = new URL(f.service.startOAuth(f.session, ['sheets']).url);
  f.config.origin = 'https://changed.example';
  await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'changed-code' }), /settings changed/);
  f.config.origin = config.origin;
  for (const unverified of [false, true]) {
    url = new URL(f.service.startOAuth(f.session, ['sheets']).url);
    globalThis.fetch = async input => String(input).includes('/token')
      ? Response.json({ access_token: 'bad-token', refresh_token: 'bad-refresh', ...(unverified ? { scope: scopesFor('sheets') } : {}) })
      : Response.json({ sub: 'bad', email: 'bad@example.com', email_verified: false });
    await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'bad-code' }), unverified ? /verified account identity/ : /granted permissions/);
  }
  assert.deepEqual(f.service.listAccounts(), []);
});

test('OAuth state expires and cannot be used after its session is revoked', async t => {
  const f = fixture(t);
  let url = new URL(f.service.startOAuth(f.session, ['sheets']).url);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 11 * 60_000;
    await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'expired-code' }), /expired/);
  } finally { Date.now = originalNow; }
  url = new URL(f.service.startOAuth(f.session, ['sheets']).url);
  f.store.deleteSession(f.session);
  await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'revoked-code' }), /Sign in/);
});

test('sign-out or account removal during OAuth prevents a pending callback from restoring access', async t => {
  for (const disconnect of [false, true]) {
    const f = fixture(t);
    const account = await connect(f, 'first');
    const url = new URL(f.service.startOAuth(f.session, ['sheets'], account.id).url);
    globalThis.fetch = async input => {
      if (String(input).includes('/token')) return Response.json({ access_token: 'late-private-token', refresh_token: 'late-private-refresh', scope: scopesFor('sheets') });
      if (disconnect) f.service.disconnect(account.id);
      else f.store.deleteSession(f.session);
      return Response.json({ sub: 'first', email: 'first@example.com', email_verified: true });
    };
    await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'late-code' }), disconnect ? /disconnected during/ : /session ended/);
    if (disconnect) assert.deepEqual(f.service.listAccounts(), []);
    else assert.equal((await f.service.getCredential(account.id)).accessToken, 'access-private-first');
  }
});

test('each AI agent receives only its assigned accounts and apps, with explicit account selection', async t => {
  const f = fixture(t);
  const first = await connect(f, 'first', ['sheets', 'gmail']);
  const second = await connect(f, 'second', ['docs', 'sheets']);
  const grok = f.service.createProfile({ name: 'Grok', bindings: [{ accountId: first.id, apps: ['sheets'] }], defaultAccountId: first.id });
  const claude = f.service.createProfile({ name: 'Claude', bindings: [{ accountId: second.id, apps: ['docs'] }] });
  assert.equal(grok.profile.bindings[0].accountEmail, first.email);
  assert.equal(f.service.resolveAgentKey(grok.apiKey)?.id, grok.profile.id);
  assert.equal(f.service.resolveAgentKey(claude.apiKey)?.id, claude.profile.id);
  assert.equal(f.service.authorize(grok.profile.id, 'sheets').id, first.id);
  assert.throws(() => f.service.authorize(grok.profile.id, 'gmail'), /not allowed/);
  assert.throws(() => f.service.authorize(grok.profile.id, 'sheets', second.id), /not allowed/);
  assert.throws(() => f.service.authorize(claude.profile.id, 'docs'), (error: unknown) => error instanceof ProviderError && error.status === 409);
  assert.equal(f.service.authorize(claude.profile.id, 'docs', second.id).email, second.email);
  assert.throws(() => f.service.createProfile({ name: 'Unknown default', bindings: [{ accountId: first.id, apps: ['sheets'] }], defaultAccountId: second.id }), /default account/);
  assert.throws(() => f.service.createProfile({ name: 'Duplicate', bindings: [{ accountId: first.id, apps: ['sheets'] }, { accountId: first.id, apps: ['gmail'] }] }), /once/);
});

test('profile edits, key rotation, and revocation apply immediately without reconnecting accounts', async t => {
  const f = fixture(t);
  const account = await connect(f, 'first', ['sheets', 'tasks']);
  const original = f.service.createProfile({ name: 'Grok', bindings: [{ accountId: account.id, apps: ['sheets'] }], defaultAccountId: account.id });
  f.service.updateProfile(original.profile.id, { name: 'Grok tasks', bindings: [{ accountId: account.id, apps: ['tasks'] }] });
  assert.equal(f.service.resolveAgentKey(original.apiKey)?.name, 'Grok tasks');
  assert.throws(() => f.service.authorize(original.profile.id, 'sheets', account.id), /not allowed/);
  assert.throws(() => f.service.authorize(original.profile.id, 'tasks'), /Specify/);
  assert.equal(f.service.authorize(original.profile.id, 'tasks', account.id).id, account.id);
  const rotated = f.service.rotateProfileKey(original.profile.id);
  assert.equal(f.service.resolveAgentKey(original.apiKey), null);
  assert.equal(f.service.resolveAgentKey(rotated.apiKey)?.id, original.profile.id);
  assert.equal(f.service.resolveAgentKey('wsa_' + 'a'.repeat(43)), null);
  f.service.deleteProfile(original.profile.id);
  assert.equal(f.service.resolveAgentKey(rotated.apiKey), null);
  assert.equal(f.service.getAgent(original.profile.id), null);
  assert.throws(() => f.service.authorize(original.profile.id, 'tasks', account.id), /revoked/);
  assert.equal((await f.service.getCredential(account.id)).refreshToken, 'refresh-private-first');
});

test('disconnect removes only the chosen Google account and its agent bindings', async t => {
  const f = fixture(t);
  const first = await connect(f, 'first');
  const second = await connect(f, 'second');
  const profile = f.service.createProfile({ name: 'Grok', bindings: [{ accountId: first.id, apps: ['sheets'] }, { accountId: second.id, apps: ['sheets'] }], defaultAccountId: first.id });
  f.service.disconnect(first.id);
  const updated = f.service.resolveAgentKey(profile.apiKey)!;
  assert.deepEqual(updated.bindings.map(binding => binding.accountId), [second.id]);
  assert.equal(updated.defaultAccountId, undefined);
  assert.deepEqual(f.service.listAccounts().map(account => account.id), [second.id]);
  await assert.rejects(f.service.getCredential(first.id), /not connected/);
  assert.equal((await f.service.getCredential(second.id)).accessToken, 'access-private-second');
});

test('refresh calls serialize per Google account and persist rotated refresh tokens', async t => {
  const f = fixture(t);
  const first = await connect(f, 'first');
  const second = await connect(f, 'second');
  for (const account of [first, second]) f.store.updateCredential(`google-workspace:${account.id}`, { ...f.store.credential(`google-workspace:${account.id}`)!, expiresAt: Date.now() - 1000 });
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.equal(String(input), 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init?.body as URLSearchParams);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('client_secret'), google.GOOGLE_CLIENT_SECRET);
    const subject = body.get('refresh_token') === 'refresh-private-first' ? 'first' : 'second';
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ access_token: `updated-private-${subject}`, refresh_token: `rotated-private-${subject}`, expires_in: 3600 });
  };
  const results = await Promise.all([f.service.getCredential(first.id), f.service.getCredential(first.id), f.service.getCredential(second.id)]);
  assert.equal(requests, 2);
  assert.deepEqual(results.map(result => result.accessToken), ['updated-private-first', 'updated-private-first', 'updated-private-second']);
  assert.equal(f.store.credential(`google-workspace:${first.id}`)?.refreshToken, 'rotated-private-first');
  assert.equal(f.store.credential(`google-workspace:${second.id}`)?.refreshToken, 'rotated-private-second');
});

test('disconnect during refresh never restores credentials or account access', async t => {
  const f = fixture(t);
  const account = await connect(f, 'first');
  f.store.updateCredential(`google-workspace:${account.id}`, { ...f.store.credential(`google-workspace:${account.id}`)!, expiresAt: 1 });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async () => {
    await blocked;
    return Response.json({ access_token: 'should-not-persist', refresh_token: 'should-not-persist-refresh', expires_in: 3600 });
  };
  const refreshing = f.service.getCredential(account.id);
  f.service.disconnect(account.id);
  release();
  await assert.rejects(refreshing, /disconnected/);
  assert.equal(f.store.credential(`google-workspace:${account.id}`), null);
  assert.deepEqual(f.service.listAccounts(), []);
});

test('Google scope reductions during refresh are enforced against existing agent bindings', async t => {
  const f = fixture(t);
  const account = await connect(f, 'first', ['sheets', 'gmail']);
  const profile = f.service.createProfile({ name: 'Grok', bindings: [{ accountId: account.id, apps: ['sheets', 'gmail'] }], defaultAccountId: account.id });
  f.store.updateCredential(`google-workspace:${account.id}`, { ...f.store.credential(`google-workspace:${account.id}`)!, expiresAt: 1 });
  globalThis.fetch = async () => Response.json({ access_token: 'reduced-private-token', expires_in: 3600, scope: scopesFor('sheets') });
  await f.service.getCredential(account.id);
  assert.throws(() => f.service.authorize(profile.profile.id, 'gmail'), /not granted access/);
  assert.equal(f.service.authorize(profile.profile.id, 'sheets').id, account.id);
  assert.equal(f.store.credential(`google-workspace:${account.id}`)?.refreshToken, 'refresh-private-first');
});

test('refresh retry clears a prior error and retains a Maps key changed during the request', async t => {
  const f = fixture(t);
  const account = await connect(f, 'first');
  f.store.updateCredential(`google-workspace:${account.id}`, { ...f.store.credential(`google-workspace:${account.id}`)!, expiresAt: 1 });
  globalThis.fetch = async () => Response.json({ error: 'private denial' }, { status: 403 });
  await assert.rejects(f.service.getCredential(account.id), /denied access/);
  assert.equal(f.service.listAccounts()[0].status, 'error');
  globalThis.fetch = async () => {
    f.service.saveMapsKey(account.id, 'maps-private-new-project');
    return Response.json({ access_token: 'retry-private-token', expires_in: 3600 });
  };
  const credential = await f.service.getCredential(account.id);
  assert.equal(credential.fields?.mapsApiKey, 'maps-private-new-project');
  assert.equal(f.service.listAccounts()[0].status, 'connected');
});

test('Maps keys stay isolated per account, bypass unrelated OAuth refresh, and never enter snapshots', async t => {
  const f = fixture(t);
  const first = await connect(f, 'first');
  const second = await connect(f, 'second');
  f.service.saveMapsKey(first.id, 'maps-private-first');
  f.service.saveMapsKey(second.id, 'maps-private-second');
  const profile = f.service.createProfile({ name: 'Grok', bindings: [{ accountId: first.id, apps: ['maps'] }], defaultAccountId: first.id });
  assert.equal(f.service.authorize(profile.profile.id, 'maps').id, first.id);
  f.store.updateCredential(`google-workspace:${first.id}`, { ...f.store.credential(`google-workspace:${first.id}`)!, expiresAt: 1 });
  globalThis.fetch = async () => { throw new Error('Maps must not refresh Google OAuth'); };
  assert.deepEqual(await f.service.getCredential(first.id, 'maps'), { accessToken: '', fields: { mapsApiKey: 'maps-private-first' } });
  assert.equal((await f.service.getCredential(second.id, 'maps')).fields?.mapsApiKey, 'maps-private-second');
  f.service.removeMapsKey(first.id);
  assert.deepEqual(f.service.getAgent(profile.profile.id)?.bindings, []);
  assert.equal(f.service.getAgent(profile.profile.id)?.defaultAccountId, undefined);
  assert.throws(() => f.service.authorize(profile.profile.id, 'maps', first.id), /not allowed/);
  f.service.saveMapsKey(first.id, 'replacement-maps-key');
  assert.throws(() => f.service.authorize(profile.profile.id, 'maps', first.id), /not allowed/);
  const snapshot = JSON.stringify(f.service.snapshot());
  for (const secret of ['maps-private-first', 'maps-private-second', 'access-private', 'refresh-private', profile.apiKey, 'keyHash']) assert.equal(snapshot.includes(secret), false);
});

test('accounts and profiles survive database reopen while credential and agent secrets remain encrypted', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'connector-workspace-'));
  const path = join(directory, 'connector.sqlite');
  const f = fixture(t, path);
  // The store close hook runs first, so Windows can remove its SQLite files.
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const account = await connect(f, 'persisted', ['sheets', 'tasks']);
  f.service.saveMapsKey(account.id, 'maps-private-persisted');
  const created = f.service.createProfile({ name: 'Saved Grok', bindings: [{ accountId: account.id, apps: ['tasks', 'maps'] }], defaultAccountId: account.id });
  const reopened = new Store(path, key);
  try {
    const service = new WorkspaceAccounts(config, reopened, google);
    assert.equal(service.resolveAgentKey(created.apiKey)?.name, 'Saved Grok');
    assert.equal(service.authorize(created.profile.id, 'tasks').email, account.email);
    assert.equal((await service.getCredential(account.id)).refreshToken, 'refresh-private-persisted');
  } finally { reopened.close(); }
  for (const name of readdirSync(directory)) {
    const raw = readFileSync(join(directory, name));
    for (const secret of [created.apiKey, 'access-private-persisted', 'refresh-private-persisted', 'maps-private-persisted', f.session, 'Saved Grok']) assert.equal(raw.includes(Buffer.from(secret)), false, `${name} contains an unencrypted secret`);
  }
});

test('unsupported apps, malformed profile input, and secret upstream errors fail safely', async t => {
  const f = fixture(t);
  assert.throws(() => f.service.startOAuth(f.session, ['maps']), /separate project API key/);
  assert.throws(() => f.service.startOAuth(f.session, ['unlisted']), /supported Google/);
  assert.throws(() => f.service.startOAuth('', ['sheets']), /Sign in/);
  assert.throws(() => f.service.createProfile({ name: 'Grok', bindings: 'invalid' }), /Choose the Google accounts/);
  const url = new URL(f.service.startOAuth(f.session, ['sheets']).url);
  globalThis.fetch = async () => Response.json({ error: 'private upstream access-token-secret' }, { status: 403 });
  await assert.rejects(f.service.finishOAuth(f.session, { state: url.searchParams.get('state'), code: 'bad-code' }), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.message.includes('access-token-secret'), false);
    return true;
  });
});

test('Workspace reset clears all accounts, Maps keys, pending sign-ins and bindings while preserving profile keys and other platforms', async t => {
  const f = fixture(t);
  const first = await connect(f, 'first');
  const second = await connect(f, 'second');
  f.service.saveMapsKey(first.id, 'private-maps-key');
  f.store.save('wordpress', { accessToken: 'private-blog-token' }, { accountName: 'Blog', resources: [] });
  const agent = f.service.createProfile({ name: 'Grok', bindings: [{ accountId: first.id, apps: ['sheets', 'maps'] }, { accountId: second.id, apps: ['sheets'] }], defaultAccountId: first.id });
  const pending = new URL(f.service.startOAuth(f.session, ['gmail']).url);
  f.service.resetAll();
  assert.deepEqual(f.service.listAccounts(), []);
  for (const account of [first, second]) assert.equal(f.store.credential(`google-workspace:${account.id}`), null);
  assert.deepEqual(f.service.resolveAgentKey(agent.apiKey)?.bindings, []);
  assert.equal(f.service.resolveAgentKey(agent.apiKey)?.defaultAccountId, undefined);
  assert.equal(f.store.credential('wordpress')?.accessToken, 'private-blog-token');
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Reset sign-in must never contact Google'); };
  await assert.rejects(f.service.finishOAuth(f.session, { state: pending.searchParams.get('state'), code: 'old-code' }), /expired/);
  assert.equal(requests, 0);
  const reconnected = await connect(f, 'first', ['gmail']);
  assert.equal(reconnected.id, first.id);
  assert.deepEqual(reconnected.apps, ['gmail']);
  assert.equal(reconnected.mapsConfigured, false);
  assert.deepEqual(f.service.resolveAgentKey(agent.apiKey)?.bindings, []);
  assert.throws(() => f.service.authorize(agent.profile.id, 'gmail', reconnected.id), /not allowed/);
});

test('account reset blocks an unbound OAuth callback already in flight even after the same account reconnects', async t => {
  const f = fixture(t);
  const first = await connect(f, 'first');
  const other = await connect(f, 'other');
  const start = new URL(f.service.startOAuth(f.session, ['gmail']).url);
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async input => {
    if (String(input).includes('/token')) return Response.json({ access_token: 'old-late-token', refresh_token: 'old-late-refresh', scope: scopesFor('gmail') });
    entered();
    await blocked;
    return Response.json({ sub: 'first', email: 'first@example.com', email_verified: true });
  };
  const finishing = f.service.finishOAuth(f.session, { state: start.searchParams.get('state'), code: 'old-code' });
  await waiting;
  f.service.disconnect(first.id);
  const reconnected = await connect(f, 'first', ['tasks']);
  release();
  await assert.rejects(finishing, error => error instanceof ProviderError && error.status === 409);
  assert.deepEqual(reconnected.apps, ['tasks']);
  assert.equal((await f.service.getCredential(first.id)).accessToken, 'access-private-first');
  assert.equal((await f.service.getCredential(other.id)).accessToken, 'access-private-other');
});

test('Workspace-wide reset during token exchange stops the old callback before identity lookup', async t => {
  const f = fixture(t);
  const start = new URL(f.service.startOAuth(f.session, ['sheets']).url);
  let calls = 0;
  globalThis.fetch = async input => {
    calls++;
    assert.equal(String(input), 'https://oauth2.googleapis.com/token');
    f.service.resetAll();
    return Response.json({ access_token: 'late-access', refresh_token: 'late-refresh', scope: scopesFor('sheets') });
  };
  await assert.rejects(f.service.finishOAuth(f.session, { state: start.searchParams.get('state'), code: 'old-code' }), error => error instanceof ProviderError && error.status === 409);
  assert.equal(calls, 1);
  assert.deepEqual(f.service.listAccounts(), []);
});

test('a refresh started before reset cannot replace a freshly reconnected account even if Google returns identical credentials', async t => {
  const f = fixture(t);
  const first = await connect(f, 'first');
  f.store.updateCredential(`google-workspace:${first.id}`, { ...f.store.credential(`google-workspace:${first.id}`)!, expiresAt: 1 });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async () => {
    await blocked;
    return Response.json({ access_token: 'stale-refresh-result', refresh_token: 'stale-refresh-token', expires_in: 3600 });
  };
  const refreshing = f.service.getCredential(first.id);
  f.service.disconnect(first.id);
  await connect(f, 'first');
  release();
  await assert.rejects(refreshing, error => error instanceof ProviderError && error.status === 409);
  assert.equal((await f.service.getCredential(first.id)).accessToken, 'access-private-first');
  assert.equal(f.store.connection(`google-workspace:${first.id}`)?.status, 'connected');
});
