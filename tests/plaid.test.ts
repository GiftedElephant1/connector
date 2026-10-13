import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Store } from '../server/store';
import { isPlaidExchangeActive, mountPlaid, removePlaidItem, verifyPlaid } from '../server/providers-plaid';
import { plaidConfig, plaidCountryCodes, plaidRequest } from '../server/plaid-http';
import { ProviderError, type Credential } from '../server/provider-types';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const settings = { PLAID_CLIENT_ID: 'client-private', PLAID_SECRET: 'secret-private', PLAID_ENV: 'sandbox', PLAID_COUNTRY_CODES: 'US,CA' };
const credential: Credential = { accessToken: 'access-sandbox-private', fields: { plaidEnvironment: 'sandbox', plaidClientId: settings.PLAID_CLIENT_ID, plaidItemId: 'item-one' } };
const accountResult = { item: { item_id: 'item-one', institution_id: 'ins-one' }, accounts: [{ account_id: 'account-one', name: 'Checking', mask: '6789', type: 'depository', routing: 'not-for-client', balances: { current: 123.45 } }] };
const tokenResult = () => ({ link_token: 'link-sandbox-private', expiration: new Date(Date.now() + 4 * 60 * 60_000).toISOString() });
const json = (init?: RequestInit): Record<string, any> => JSON.parse(String(init?.body));

async function fixture(t: TestContext, origin = 'https://connector.example') {
  const store = new Store(':memory:', Buffer.alloc(32, 7));
  const env = { ...settings };
  const app = express();
  app.use(express.json());
  mountPlaid(app, store, env, request => String(request.headers['x-test-session'] || ''), () => origin, Buffer.alloc(32, 7));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const providerError = error instanceof ProviderError;
    response.status(providerError ? error.status : 500).json({ error: providerError ? error.message : 'Internal error' });
  });
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = store.createSession();
  const request = (path: string, body = {}, token = session) => originalFetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-session': token }, body: JSON.stringify(body) });
  return { store, env, session, request };
}

test('Plaid supports only fixed official environments and allowlisted operations', async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://production.plaid.com/accounts/get');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('Plaid-Version'), '2020-09-14');
    assert.deepEqual(json(init), { client_id: settings.PLAID_CLIENT_ID, secret: settings.PLAID_SECRET, access_token: credential.accessToken });
    return Response.json(accountResult);
  };
  assert.equal(plaidConfig({ ...settings, PLAID_ENV: '' }).environment, 'sandbox');
  assert.throws(() => plaidConfig({ ...settings, PLAID_ENV: 'https://attacker.example' }), /Sandbox or Production/);
  assert.throws(() => plaidConfig({ ...settings, PLAID_SECRET: '' }), /client ID and secret/);
  await assert.rejects(plaidRequest('/transfer/create', {}, settings), /not supported/);
  await assert.rejects(plaidRequest('https://attacker.example/accounts/get', {}, settings), /not supported/);
  await assert.rejects(plaidRequest('/accounts/get', {}, { ...settings, PLAID_ENV: 'production' }, credential), /different Plaid settings/);
  await assert.rejects(plaidRequest('/accounts/get', {}, { ...settings, PLAID_CLIENT_ID: 'other' }, credential), /different Plaid settings/);
  assert.equal(calls, 0);
  await plaidRequest('/accounts/get', {}, { ...settings, PLAID_ENV: 'production' }, { ...credential, fields: { ...credential.fields, plaidEnvironment: 'production' } });
  assert.equal(calls, 1);
});

test('Plaid country selection rejects unsupported countries before sending a request', () => {
  assert.deepEqual(plaidCountryCodes({}), ['US']);
  assert.deepEqual(plaidCountryCodes({ PLAID_COUNTRY_CODES: 'us, CA,US' }), ['US', 'CA']);
  for (const value of ['TW', 'US,', 'US,https://attacker.example']) assert.throws(() => plaidCountryCodes({ PLAID_COUNTRY_CODES: value }), /supported Plaid country/);
});

test('Link sessions use opaque stable owner identity and correct HTTPS OAuth redirect', async t => {
  const f = await fixture(t);
  const users: string[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://sandbox.plaid.com/link/token/create');
    const body = json(init);
    assert.deepEqual(body.products, ['transactions']);
    assert.deepEqual(body.country_codes, ['US', 'CA']);
    assert.equal(body.redirect_uri, 'https://connector.example/plaid/callback');
    assert.equal(body.client_name, 'Connector');
    assert.equal(body.language, 'en');
    assert.match(body.user.client_user_id, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(body).includes(f.session), false);
    users.push(body.user.client_user_id);
    return Response.json(tokenResult());
  };
  assert.equal((await f.request('/api/plaid/link-token', {}, '')).status, 401);
  const response = await f.request('/api/plaid/link-token');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.environment, 'sandbox');
  assert.equal(body.linkToken, 'link-sandbox-private');
  assert.match(body.flowId, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(body.expiresAt) <= Date.now() + 10 * 60_000);
  assert.equal(JSON.stringify(body).includes(settings.PLAID_SECRET), false);
  await f.request('/api/plaid/link-token', {}, f.store.createSession());
  assert.equal(users[0], users[1]);
});

test('public token exchange is one-time and bound to the authenticated Link session', async t => {
  const f = await fixture(t);
  const paths: string[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/link/token/create') return Response.json(tokenResult());
    if (path === '/item/public_token/exchange') {
      assert.equal(json(init).public_token, 'public-once');
      return Response.json({ access_token: credential.accessToken, item_id: 'item-one' });
    }
    assert.equal(path, '/accounts/get');
    assert.equal(json(init).access_token, credential.accessToken);
    return Response.json(accountResult);
  };
  const { flowId } = await (await f.request('/api/plaid/link-token')).json();
  const payload = { flowId, publicToken: 'public-once' };
  assert.equal((await f.request('/api/plaid/exchange', payload, f.store.createSession())).status, 400);
  assert.deepEqual(paths, ['/link/token/create']);
  const response = await f.request('/api/plaid/exchange', payload);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.connection.accountName, 'Plaid SANDBOX test data');
  assert.deepEqual(result.connection.resources, [{ id: 'account-one', name: 'Checking · •••• 6789', type: 'bank-account' }]);
  const publicJson = JSON.stringify(result);
  for (const secret of [credential.accessToken, settings.PLAID_SECRET, '123.45', 'not-for-client']) assert.equal(publicJson.includes(secret), false);
  assert.deepEqual(f.store.credential('plaid'), credential);
  f.store.disconnect('plaid');
  assert.equal((await f.request('/api/plaid/exchange', payload)).status, 400);
  assert.deepEqual(paths, ['/link/token/create', '/item/public_token/exchange', '/accounts/get']);
});

test('expired or configuration-changed Link flows cannot exchange public tokens', async t => {
  const f = await fixture(t);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(tokenResult()); };
  const first = await (await f.request('/api/plaid/link-token')).json();
  f.env.PLAID_ENV = 'production';
  const changed = await f.request('/api/plaid/exchange', { flowId: first.flowId, publicToken: 'public-one' });
  assert.equal(changed.status, 400);
  assert.match((await changed.json()).error, /settings changed/);
  f.env.PLAID_ENV = 'sandbox';
  const second = await (await f.request('/api/plaid/link-token')).json();
  t.mock.method(Date, 'now', () => new Date(second.expiresAt).getTime() + 1000);
  assert.equal((await f.request('/api/plaid/exchange', { flowId: second.flowId, publicToken: 'public-two' })).status, 400);
  assert.equal(calls, 2);
});

test('bank verification failure revokes the newly created Item before reporting failure', async t => {
  const f = await fixture(t);
  const paths: string[] = [];
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/link/token/create') return Response.json(tokenResult());
    if (path === '/item/public_token/exchange') return Response.json({ access_token: credential.accessToken, item_id: 'item-one' });
    if (path === '/accounts/get') return Response.json({ error_message: credential.accessToken }, { status: 500 });
    assert.equal(path, '/item/remove');
    return Response.json({ request_id: 'removed-request' });
  };
  const { flowId } = await (await f.request('/api/plaid/link-token')).json();
  const response = await f.request('/api/plaid/exchange', { flowId, publicToken: 'public-one' });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /revoked/);
  assert.equal(f.store.connection('plaid'), null);
  assert.deepEqual(paths, ['/link/token/create', '/item/public_token/exchange', '/accounts/get', '/item/remove']);
});

test('a failed Item revocation retains the encrypted connection for recovery and blocks replacement', async t => {
  const f = await fixture(t);
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const path = new URL(String(url)).pathname;
    if (path === '/link/token/create') return Response.json(tokenResult());
    if (path === '/item/public_token/exchange') return Response.json({ access_token: credential.accessToken, item_id: 'item-one' });
    return Response.json({ error_message: settings.PLAID_SECRET }, { status: 500 });
  };
  const { flowId } = await (await f.request('/api/plaid/link-token')).json();
  const response = await f.request('/api/plaid/exchange', { flowId, publicToken: 'public-one' });
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes(settings.PLAID_SECRET), false);
  assert.equal(f.store.connection('plaid')?.status, 'error');
  assert.deepEqual(f.store.credential('plaid'), credential);
  assert.equal((await f.request('/api/plaid/link-token')).status, 409);
  assert.equal(calls, 4);
});

test('changing mutable settings during exchange revokes the Item with the original credentials', async t => {
  const f = await fixture(t);
  let release: () => void = () => {};
  let started: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const paths: string[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).origin, 'https://sandbox.plaid.com');
    assert.equal(json(init).secret, settings.PLAID_SECRET);
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/link/token/create') return Response.json(tokenResult());
    if (path === '/item/public_token/exchange') {
      assert.equal(isPlaidExchangeActive(f.store), true);
      started();
      await gate;
      return Response.json({ access_token: credential.accessToken, item_id: 'item-one' });
    }
    if (path === '/accounts/get') return Response.json(accountResult);
    assert.equal(path, '/item/remove');
    return Response.json({ request_id: 'removed-request' });
  };
  const { flowId } = await (await f.request('/api/plaid/link-token')).json();
  const pending = f.request('/api/plaid/exchange', { flowId, publicToken: 'public-one' });
  await began;
  assert.equal(isPlaidExchangeActive(f.store), true);
  f.env.PLAID_ENV = 'production';
  f.env.PLAID_SECRET = 'changed-secret';
  release();
  const response = await pending;
  assert.equal(response.status, 502);
  assert.equal(f.store.credential('plaid'), null);
  assert.equal(isPlaidExchangeActive(f.store), false);
  assert.deepEqual(paths, ['/link/token/create', '/item/public_token/exchange', '/accounts/get', '/item/remove']);
});

test('Production linking requires HTTPS while localhost Sandbox omits the bank OAuth redirect', async t => {
  const f = await fixture(t, 'http://localhost:3000');
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(json(init).redirect_uri, undefined);
    return Response.json(tokenResult());
  };
  assert.equal((await f.request('/api/plaid/link-token')).status, 200);
  f.env.PLAID_ENV = 'production';
  const response = await f.request('/api/plaid/link-token');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /HTTPS address/);
  assert.equal(calls, 1);
});

test('Plaid errors and malformed responses never expose financial tokens or upstream bodies', async () => {
  for (const [status, body] of [[400, { error_code: 'INVALID_ACCESS_TOKEN', error_message: credential.accessToken }], [200, { error_code: 'PRODUCT_NOT_READY', error_message: settings.PLAID_SECRET }], [200, []]] as const) {
    globalThis.fetch = async () => Response.json(body, { status });
    await assert.rejects(verifyPlaid(credential, settings), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(credential.accessToken), false);
      assert.equal(error.message.includes(settings.PLAID_SECRET), false);
      return true;
    });
  }
  globalThis.fetch = async () => Response.json({ ...accountResult, item: { item_id: 'different-item' } });
  await assert.rejects(verifyPlaid(credential, settings), /different bank connection/);
  globalThis.fetch = async () => Response.json({});
  await assert.rejects(removePlaidItem(credential, settings), /did not confirm disconnection/);
});
