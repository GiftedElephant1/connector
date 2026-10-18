import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { Store } from '../server/store.ts';
import type { Credential } from '../server/provider-types.ts';

const realFetch = globalThis.fetch;
const holder = 'tiktok-business-account';
const origin = 'https://connector.example';
const callbackUrl = `${origin}/api/oauth/${holder}/callback/`;
const accountId = 'fixture-tiktok-open-id';
const scope = 'user.info.basic';
const priorHolder: Credential = { accessToken: 'private-old-holder-token', refreshToken: 'private-old-holder-refresh', fields: { openId: accountId, scope } };
const retained = {
  'tiktok-business': { accessToken: 'private-advertiser-token' },
  tiktok: { accessToken: 'private-login-kit-token', refreshToken: 'private-login-kit-refresh' },
  wordpress: { accessToken: 'private-unrelated-token' },
};

async function fixture(t: TestContext, connected = false) {
  const directory = mkdtempSync(join(tmpdir(), 'connector-tiktok-holder-'));
  const databasePath = join(directory, 'fixture.sqlite');
  const config: AppConfig = { origin, host: '127.0.0.1', port: 3000, password: 'private-test-owner-password', encryptionKey: Buffer.alloc(32, 89), databasePath, secureCookies: false };
  const authorization = new URL('https://www.tiktok.com/v2/auth/authorize/');
  authorization.search = new URLSearchParams({ client_key: 'portal-client-key-distinct-from-app-id', scope, response_type: 'code', redirect_uri: callbackUrl }).toString();
  const env: NodeJS.ProcessEnv = {
    TIKTOK_BUSINESS_APP_ID: '1234567890123456789', TIKTOK_BUSINESS_APP_SECRET: 'private-business-secret',
    TIKTOK_BUSINESS_ACCOUNT_AUTH_URL: authorization.toString(),
    TIKTOK_CLIENT_KEY: 'separate-login-kit-key', TIKTOK_CLIENT_SECRET: 'private-login-kit-secret',
  };
  const store = new Store(databasePath, config.encryptionKey);
  const account = { accountId, accountName: 'Existing account', resources: [] };
  for (const [id, credential] of Object.entries(retained)) store.save(id, credential, account);
  const previousConnection = connected ? store.save(holder, priorHolder, account) : null;
  const app = createApp(config, store, undefined, env);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = store.createSession();
  const cookie = `connector_session=${session}`;
  const request = (path: string, init: RequestInit = {}) => realFetch(`${base}${path}`, { redirect: 'manual', ...init });
  const mutate = (path: string, body: unknown = {}, method = 'POST') => request(path, { method, headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify(body) });
  const start = async () => {
    const response = await mutate(`/api/oauth/${holder}/start`);
    assert.equal(response.status, 200, await response.clone().text());
    const url = new URL((await response.json()).url);
    assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
    assert.equal(url.searchParams.get('client_key'), 'portal-client-key-distinct-from-app-id');
    assert.equal(url.searchParams.get('redirect_uri'), callbackUrl);
    assert.equal(url.searchParams.get('scope'), scope);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('disable_auto_auth'), '1');
    assert.equal(url.searchParams.has('client_secret'), false);
    const state = url.searchParams.get('state');
    assert.ok(state);
    return state;
  };
  const callback = (state: string, query = 'auth_code=private-authorization-code', sessionCookie = cookie, provider = holder) => request(`/api/oauth/${provider}/callback/?state=${encodeURIComponent(state)}&${query}`, { headers: { cookie: sessionCookie } });
  const assertRetained = () => {
    for (const [id, credential] of Object.entries(retained)) assert.deepEqual(store.credential(id), credential, `${id} must retain its own credential`);
  };
  return { config, env, databasePath, store, session, cookie, request, mutate, start, callback, assertRetained, previousConnection };
}

type Call = { path: string; body: Record<string, unknown> };
function mockApi(t: TestContext, handle: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://business-api.tiktok.com', 'holder credentials must only reach the official Business API');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    const call = { path: url.pathname, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    calls.push(call);
    return handle(call);
  });
  return calls;
}
const successToken = (accessToken = 'private-new-holder-token', refreshToken = 'private-new-holder-refresh') => Response.json({ code: 0, data: { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, open_id: accountId, scope } });
const tokenInfo = (appId: string, creatorId = accountId) => Response.json({ code: 0, data: { app_id: appId, creator_id: creatorId, scope } });

test('Business account-holder authorization uses the portal client key and saves a separate verified encrypted credential', async t => {
  const f = await fixture(t);
  const calls = mockApi(t, call => {
    if (call.path === '/open_api/v1.3/tt_user/oauth2/token/') {
      assert.deepEqual(call.body, { client_id: f.env.TIKTOK_BUSINESS_APP_ID, client_secret: f.env.TIKTOK_BUSINESS_APP_SECRET, grant_type: 'authorization_code', auth_code: 'private-authorization-code', redirect_uri: callbackUrl });
      return successToken();
    }
    assert.equal(call.path, '/open_api/v1.3/tt_user/token_info/get/');
    assert.deepEqual(call.body, { app_id: f.env.TIKTOK_BUSINESS_APP_ID, access_token: 'private-new-holder-token' });
    return tokenInfo(f.env.TIKTOK_BUSINESS_APP_ID!);
  });
  const setup = await (await f.request(`/api/settings/providers/${holder}`, { headers: { cookie: f.cookie } })).json();
  assert.equal(setup.callbackUrl, callbackUrl);
  assert.doesNotMatch(JSON.stringify(setup), /private-business-secret|private-login-kit-secret/);
  const parentBefore = await (await f.request('/api/settings/providers/tiktok-business', { headers: { cookie: f.cookie } })).json();
  assert.equal(parentBefore.companion.id, holder);
  assert.equal(parentBefore.companion.connection, null);
  const state = await f.start();
  const response = await f.callback(state);
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get('location')!, origin).searchParams.get('error'), null);
  assert.equal(f.store.credential(holder)?.accessToken, 'private-new-holder-token');
  assert.equal(f.store.credential(holder)?.refreshToken, 'private-new-holder-refresh');
  assert.deepEqual(f.store.credential(holder)?.fields, { openId: accountId, scope });
  assert.equal(f.store.connection(holder)?.accountId, accountId);
  assert.deepEqual(f.store.connection(holder)?.resources, [{ id: accountId, name: `TikTok account ${accountId}`, type: 'tiktok_account' }]);
  f.assertRetained();
  const parentAfter = await (await f.request('/api/settings/providers/tiktok-business', { headers: { cookie: f.cookie } })).json();
  assert.equal(parentAfter.companion.connection.accountId, accountId);
  assert.equal(parentAfter.companion.connection.status, 'connected');
  assert.doesNotMatch(JSON.stringify(parentAfter), /private-new-holder-token|private-new-holder-refresh|private-business-secret/);
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT secret, summary FROM connections WHERE provider = ?').get(holder)!;
    assert.doesNotMatch(JSON.stringify(row), /private-new-holder-token|private-new-holder-refresh/);
    assert.equal(String(row.secret).split('.').length, 3);
  } finally { db.close(); }
  const catalog = await (await f.request('/api/providers', { headers: { cookie: f.cookie } })).json();
  assert.equal(catalog.providers.some((provider: { id: string }) => provider.id === holder), false, 'auxiliary authorization must not appear as an actionable destination');
  assert.ok(catalog.providers.some((provider: { id: string }) => provider.id === 'tiktok-business'));
  assert.ok(catalog.providers.some((provider: { id: string }) => provider.id === 'tiktok'));
  assert.doesNotMatch(JSON.stringify(catalog), /private-new-holder-token|private-new-holder-refresh|private-business-secret/);
  const callCount = calls.length;
  const replay = await f.callback(state);
  assert.match(replay.headers.get('location')!, /^\/\?error=/);
  assert.equal(calls.length, callCount, 'a consumed state must not exchange the code again');
});

for (const failure of ['declined', 'wrong-session', 'wrong-provider', 'bad-state', 'exchange', 'verification'] as const) {
  test(`account-holder ${failure} failure preserves prior holder, advertising, Login Kit and unrelated credentials`, async t => {
    const f = await fixture(t, true);
    const calls = mockApi(t, call => {
      assert.ok(failure === 'exchange' || failure === 'verification', 'invalid OAuth context must not make an upstream call');
      if (call.path === '/open_api/v1.3/tt_user/oauth2/token/') {
        return failure === 'exchange'
          ? Response.json({ message: 'private-business-secret private-provider-detail' }, { status: 401 })
          : successToken();
      }
      assert.equal(call.path, '/open_api/v1.3/tt_user/token_info/get/');
      return tokenInfo(f.env.TIKTOK_BUSINESS_APP_ID!, 'different-account');
    });
    const state = await f.start();
    const response = await f.callback(failure === 'bad-state' ? 'unknown-state' : state,
      failure === 'declined' ? 'error=access_denied' : undefined,
      failure === 'wrong-session' ? `connector_session=${f.store.createSession()}` : undefined,
      failure === 'wrong-provider' ? 'tiktok-business' : undefined);
    assert.equal(response.status, 302);
    const error = new URL(response.headers.get('location')!, origin).searchParams.get('error');
    assert.ok(error);
    assert.doesNotMatch(error, /private-business-secret|private-provider-detail|private-new-holder-token|private-authorization-code/);
    assert.equal(calls.length, failure === 'exchange' ? 1 : failure === 'verification' ? 2 : 0);
    assert.deepEqual(f.store.credential(holder), priorHolder);
    assert.deepEqual(f.store.connection(holder), f.previousConnection);
    f.assertRetained();
  });
}

test('holder start and callback require an owner session and start requires the mutation guard', async t => {
  const f = await fixture(t);
  const calls = mockApi(t, () => { throw new Error('Unauthenticated requests must not reach TikTok.'); });
  assert.equal((await f.request(`/api/oauth/${holder}/start`, { method: 'POST', headers: { 'x-connector-request': '1' } })).status, 401);
  assert.equal((await f.request(`/api/oauth/${holder}/start`, { method: 'POST', headers: { cookie: f.cookie } })).status, 403);
  assert.equal((await f.request(`/api/oauth/${holder}/callback/?state=invalid&auth_code=private-code`)).status, 401);
  assert.equal(calls.length, 0);
});

test('holder verification refreshes its token with the Accounts API while retaining advertiser and Login Kit tokens', async t => {
  const f = await fixture(t, true);
  f.store.updateCredential(holder, { ...priorHolder, expiresAt: 1 });
  const calls = mockApi(t, call => {
    if (call.path === '/open_api/v1.3/tt_user/oauth2/refresh_token/') {
      assert.deepEqual(call.body, { client_id: f.env.TIKTOK_BUSINESS_APP_ID, client_secret: f.env.TIKTOK_BUSINESS_APP_SECRET, grant_type: 'refresh_token', refresh_token: priorHolder.refreshToken });
      return successToken('private-refreshed-holder-token', 'private-rotated-holder-refresh');
    }
    assert.equal(call.path, '/open_api/v1.3/tt_user/token_info/get/');
    assert.deepEqual(call.body, { app_id: f.env.TIKTOK_BUSINESS_APP_ID, access_token: 'private-refreshed-holder-token' });
    return tokenInfo(f.env.TIKTOK_BUSINESS_APP_ID!);
  });
  const response = await f.mutate(`/api/connections/${holder}/verify`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.doesNotMatch(await response.text(), /private-refreshed-holder-token|private-rotated-holder-refresh/);
  assert.equal(calls.length, 2);
  assert.equal(f.store.credential(holder)?.accessToken, 'private-refreshed-holder-token');
  assert.equal(f.store.credential(holder)?.refreshToken, 'private-rotated-holder-refresh');
  f.assertRetained();
});

test('resetting TikTok Business includes holder authorization and preserves ordinary TikTok and unrelated accounts', async t => {
  const f = await fixture(t, true);
  const calls = mockApi(t, () => { throw new Error('Reset must only clear local setup.'); });
  for (const id of ['tiktok-business', holder, 'tiktok']) f.store.saveOAuth(`${id}-pending-state`, f.session, id, 'private-verifier');
  const preview = await f.request('/api/connections/tiktok-business/reset', { headers: { cookie: f.cookie } });
  assert.equal(preview.status, 200);
  const plan = await preview.json();
  assert.deepEqual(plan.affectedProviders.map((provider: { id: string }) => provider.id).sort(), ['tiktok-business', holder].sort());
  assert.ok(f.store.credential(holder), 'preview must preserve the token');
  assert.equal((await f.mutate('/api/connections/tiktok-business/reset', { confirmed: true })).status, 200);
  for (const id of ['tiktok-business', holder]) {
    assert.equal(f.store.credential(id), null);
    assert.equal(f.store.takeOAuth(`${id}-pending-state`, f.session, id), null);
  }
  assert.deepEqual(f.store.credential('tiktok'), retained.tiktok);
  assert.deepEqual(f.store.credential('wordpress'), retained.wordpress);
  assert.ok(f.store.takeOAuth('tiktok-pending-state', f.session, 'tiktok'));
  for (const key of ['TIKTOK_BUSINESS_APP_ID', 'TIKTOK_BUSINESS_APP_SECRET', 'TIKTOK_BUSINESS_ACCOUNT_AUTH_URL']) assert.equal(f.env[key], '');
  assert.equal(f.env.TIKTOK_CLIENT_KEY, 'separate-login-kit-key');
  assert.equal(f.env.TIKTOK_CLIENT_SECRET, 'private-login-kit-secret');
  assert.equal(calls.length, 0);
});

test('disconnecting holder authorization independently preserves advertiser and Login Kit credentials', async t => {
  const f = await fixture(t, true);
  const response = await f.mutate(`/api/connections/${holder}`, {}, 'DELETE');
  assert.equal(response.status, 200);
  assert.equal(f.store.credential(holder), null);
  f.assertRetained();
  assert.equal(f.env.TIKTOK_BUSINESS_APP_SECRET, 'private-business-secret');
});
