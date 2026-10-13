import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createApp, type ProviderService } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { ProviderError, type Credential, type ProviderDefinition, type VerifiedAccount } from '../server/provider-types.ts';
import { Store } from '../server/store.ts';

const account: VerifiedAccount = { accountName: 'Connected account', accountId: '123', resources: [{ id: 'page-1', name: 'My page', type: 'page' }] };
const definitions: ProviderDefinition[] = [
  { id: 'openai', name: 'OpenAI', category: 'ai', authType: 'api_key', description: 'Test API', docsUrl: 'https://example.com' },
  { id: 'oauth', name: 'OAuth', category: 'social', authType: 'oauth', description: 'Test OAuth', docsUrl: 'https://example.com' },
  { id: 'fields', name: 'Fields', category: 'websites', authType: 'api_key', description: 'Test fields', docsUrl: 'https://example.com', credentialFields: [{ name: 'site', label: 'Site URL' }] },
];
const config: AppConfig = {
  origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000,
  password: 'test-app-password', encryptionKey: Buffer.alloc(32, 7), databasePath: ':memory:', secureCookies: false,
};

async function fixture(t: TestContext, overrides: Partial<ProviderService> = {}) {
  const store = new Store(':memory:', config.encryptionKey);
  const service: ProviderService = {
    providerCatalog: definitions,
    getProvider(id) {
      const definition = definitions.find((provider) => provider.id === id);
      if (!definition) throw new ProviderError('This provider is not supported.', 404);
      return definition;
    },
    getProviderSetup: () => ({ configured: true, missing: [] }),
    createOAuthRequest: (_id, input) => `https://authorization.example/authorize?state=${input.state}`,
    exchangeOAuthCode: async () => ({ accessToken: 'oauth-private-access-token', refreshToken: 'oauth-private-refresh-token' }),
    refreshCredential: async (_id, credential) => credential,
    verifyConnection: async () => account,
    ...overrides,
  };
  const app = createApp(config, store, service, {});
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, options: RequestInit = {}) => fetch(`${base}${path}`, { ...options, redirect: 'manual' });
  const mutation = (path: string, body?: unknown, cookie = '', extraHeaders: Record<string, string> = {}, method = 'POST') => request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-connector-request': '1', ...(cookie ? { cookie } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async (existingCookie = '') => {
    const response = await mutation('/api/login', { password: config.password }, existingCookie);
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    return setCookie.split(';')[0];
  };
  return { store, service, request, mutation, login };
}

test('unauthenticated clients can inspect session health but cannot read or change connections', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request('/api/health')).json(), { status: 'ok' });
  assert.deepEqual(await (await f.request('/api/session')).json(), { authenticated: false });
  for (const path of ['/api/providers', '/api/oauth/oauth/callback?state=invalid&code=code']) {
    const response = await f.request(path);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const [path, method] of [['/api/connections/openai/api-key', 'POST'], ['/api/connections/openai', 'DELETE'], ['/api/oauth/oauth/start', 'POST']]) {
    assert.equal((await f.mutation(path, { apiKey: 'private-token' }, '', {}, method)).status, 401);
  }
});

test('password login rotates the session and logout invalidates it and pending authorization', async (t) => {
  const f = await fixture(t);
  const wrong = await f.mutation('/api/login', { password: 'wrong-password' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.has('set-cookie'), false);
  const first = await f.login();
  assert.deepEqual(await (await f.request('/api/session', { headers: { cookie: first } })).json(), { authenticated: true });
  const second = await f.login(first);
  assert.notEqual(second, first);
  assert.equal((await f.request('/api/providers', { headers: { cookie: first } })).status, 401);
  const state = 'pending-state';
  const token = second.slice('connector_session='.length);
  f.store.saveOAuth(state, token, 'oauth', 'verifier');
  const loggedOut = await f.mutation('/api/logout', undefined, second);
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get('set-cookie') || '', /connector_session=;/);
  assert.equal((await f.request('/api/providers', { headers: { cookie: second } })).status, 401);
  assert.equal(f.store.takeOAuth(state, token, 'oauth'), null);
});

test('mutations require the app header and reject a foreign Origin including login', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const noHeader = await f.request('/api/connections/openai/api-key', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ apiKey: 'private-token' }),
  });
  assert.equal(noHeader.status, 403);
  for (const path of ['/api/login', '/api/connections/openai/api-key']) {
    assert.equal((await f.mutation(path, { password: config.password, apiKey: 'private-token' }, cookie, { origin: 'https://attacker.example' })).status, 403);
  }
  assert.equal((await f.mutation('/api/connections/openai/api-key', { apiKey: 'private-token' }, cookie, { origin: config.origin })).status, 200);
});

test('API keys are verified before persistence and never included in responses', async (t) => {
  let credentialSeen: Credential | undefined;
  const f = await fixture(t, {
    verifyConnection: async (id, credential) => {
      assert.equal(id, 'openai');
      assert.equal(f.store.credential(id), null);
      credentialSeen = credential;
      return account;
    },
  });
  const cookie = await f.login();
  const response = await f.mutation('/api/connections/openai/api-key', { apiKey: ' private-api-key ', fields: { attackerField: 'discard' } }, cookie);
  assert.equal(response.status, 200);
  const publicBody = await response.text();
  assert.equal(publicBody.includes('private-api-key'), false);
  assert.equal(publicBody.includes('accessToken'), false);
  assert.deepEqual(credentialSeen, { accessToken: 'private-api-key' });
  assert.deepEqual(f.store.credential('openai'), credentialSeen);
  const catalog = await f.request('/api/providers', { headers: { cookie } });
  const catalogText = await catalog.text();
  assert.equal(catalogText.includes('private-api-key'), false);
  assert.equal(catalogText.includes('Connected account'), true);
});

test('only declared valid credential fields are passed to providers or stored', async (t) => {
  let calls = 0;
  const f = await fixture(t, { verifyConnection: async () => { calls++; return account; } });
  const cookie = await f.login();
  for (const fields of [{}, { site: 'bad\r\nvalue' }, { site: 42 }, { site: 'x'.repeat(8193) }]) {
    assert.equal((await f.mutation('/api/connections/fields/api-key', { apiKey: 'private-token', fields }, cookie)).status, 400);
  }
  for (const apiKey of ['', '   ', 'bad\nvalue', 42]) {
    assert.equal((await f.mutation('/api/connections/fields/api-key', { apiKey, fields: { site: 'https://example.com' } }, cookie)).status, 400);
  }
  assert.equal(calls, 0);
  const response = await f.mutation('/api/connections/fields/api-key', {
    apiKey: 'private-token', fields: { site: ' https://example.com ', unexpected: 'must-not-persist' },
  }, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(f.store.credential('fields'), { accessToken: 'private-token', fields: { site: 'https://example.com' } });
});

test('failed credentials are not saved and raw internal errors never reach clients', async (t) => {
  const secret = 'private-token-that-must-not-leak';
  const f = await fixture(t, { verifyConnection: async () => { throw new Error(`Internal request used ${secret}`); } });
  const cookie = await f.login();
  const response = await f.mutation('/api/connections/openai/api-key', { apiKey: secret }, cookie);
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes(secret), false);
  assert.equal(f.store.credential('openai'), null);
  assert.equal(f.store.connection('openai'), null);
  const existing = { accessToken: 'existing-verified-token' };
  f.store.save('openai', existing, account);
  assert.equal((await f.mutation('/api/connections/openai/api-key', { apiKey: secret }, cookie)).status, 500);
  assert.deepEqual(f.store.credential('openai'), existing, 'a failed replacement must preserve the working connection');
});

test('upstream authentication failures mark the connection while retaining local login', async (t) => {
  const f = await fixture(t, { verifyConnection: async () => { throw new ProviderError('The platform rejected this credential.', 401); } });
  const cookie = await f.login();
  f.store.save('openai', { accessToken: 'test-token' }, account);
  const response = await f.mutation('/api/connections/openai/verify', undefined, cookie);
  assert.equal(response.status, 422);
  assert.equal(f.store.connection('openai')?.status, 'error');
  assert.deepEqual(await (await f.request('/api/session', { headers: { cookie } })).json(), { authenticated: true });
  assert.deepEqual(f.store.credential('openai'), { accessToken: 'test-token' });
});

test('refreshed credentials survive a later verification failure and preserve last verified metadata', async (t) => {
  const refreshed = { accessToken: 'new-access-token', refreshToken: 'new-rotated-refresh-token', expiresAt: Date.now() + 3600_000 };
  const f = await fixture(t, {
    refreshCredential: async () => refreshed,
    verifyConnection: async (_id, credential) => {
      assert.deepEqual(credential, refreshed);
      throw new ProviderError('The platform is temporarily unavailable.', 502);
    },
  });
  const cookie = await f.login();
  const previous = f.store.save('oauth', { accessToken: 'old-access-token', refreshToken: 'old-refresh-token', expiresAt: Date.now() - 1000 }, account);
  const response = await f.mutation('/api/connections/oauth/verify', undefined, cookie);
  assert.equal(response.status, 502);
  assert.deepEqual(f.store.credential('oauth'), refreshed);
  assert.equal(f.store.connection('oauth')?.status, 'error');
  assert.equal(f.store.connection('oauth')?.lastVerifiedAt, previous.lastVerifiedAt);
});

test('successful verification clears old errors, skips refresh for fresh tokens, and disconnect removes the account', async (t) => {
  let refreshes = 0;
  const credential = { accessToken: 'fresh-token', expiresAt: Date.now() + 3600_000 };
  const f = await fixture(t, {
    refreshCredential: async () => { refreshes++; return credential; },
    verifyConnection: async (_id, received) => {
      assert.deepEqual(received, credential);
      return { ...account, accountName: 'Updated account name' };
    },
  });
  const cookie = await f.login();
  f.store.save('oauth', credential, account);
  f.store.markError('oauth', 'Previous failure');
  const verified = await f.mutation('/api/connections/oauth/verify', undefined, cookie);
  assert.equal(verified.status, 200);
  assert.equal(f.store.connection('oauth')?.status, 'connected');
  assert.equal(f.store.connection('oauth')?.error, undefined);
  assert.equal(f.store.connection('oauth')?.accountName, 'Updated account name');
  assert.equal(refreshes, 0);
  assert.equal((await f.mutation('/api/connections/oauth', undefined, cookie, {}, 'DELETE')).status, 200);
  assert.equal(f.store.connection('oauth'), null);
  assert.equal(f.store.credential('oauth'), null);
  assert.equal((await f.mutation('/api/connections/oauth/verify', undefined, cookie)).status, 404);
});

test('OAuth callback state is bound to its initiating session and consumed only once', async (t) => {
  let exchanges = 0;
  let expectedVerifier = '';
  const f = await fixture(t, {
    createOAuthRequest: (id, input) => {
      assert.equal(id, 'oauth');
      assert.equal(input.redirectUri, `${config.origin}/api/oauth/oauth/callback`);
      assert.ok(input.codeVerifier.length >= 43);
      expectedVerifier = input.codeVerifier;
      return `https://authorization.example/authorize?state=${input.state}`;
    },
    exchangeOAuthCode: async (_id, input) => {
      exchanges++;
      assert.equal(input.code, 'official-code');
      assert.equal(input.codeVerifier, expectedVerifier);
      return { accessToken: 'oauth-private-token' };
    },
  });
  const owner = await f.login();
  const other = await f.login();
  const started = await f.mutation('/api/oauth/oauth/start', undefined, owner);
  assert.equal(started.status, 200);
  const { url } = await started.json() as { url: string };
  const state = new URL(url).searchParams.get('state');
  assert.ok(state);
  const callback = `/api/oauth/oauth/callback?state=${state}&code=official-code`;
  const foreign = await f.request(callback, { headers: { cookie: other } });
  assert.equal(foreign.status, 302);
  assert.match(foreign.headers.get('location') || '', /error=/);
  assert.equal(exchanges, 0);
  assert.equal(f.store.credential('oauth'), null);
  const accepted = await f.request(callback, { headers: { cookie: owner } });
  assert.equal(accepted.headers.get('location'), '/?connected=oauth');
  assert.equal(exchanges, 1);
  assert.deepEqual(f.store.credential('oauth'), { accessToken: 'oauth-private-token' });
  const replayed = await f.request(callback, { headers: { cookie: owner } });
  assert.match(replayed.headers.get('location') || '', /error=/);
  assert.equal(exchanges, 1);
});

test('denied and incomplete OAuth callbacks consume state without exchanging or saving credentials', async (t) => {
  let exchanges = 0;
  const f = await fixture(t, { exchangeOAuthCode: async () => { exchanges++; return { accessToken: 'token' }; } });
  const cookie = await f.login();
  for (const suffix of ['&error=access_denied&error_description=private-error-description', '']) {
    const { url } = await (await f.mutation('/api/oauth/oauth/start', undefined, cookie)).json() as { url: string };
    const state = new URL(url).searchParams.get('state');
    const response = await f.request(`/api/oauth/oauth/callback?state=${state}${suffix}`, { headers: { cookie } });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') || '', /error=/);
    assert.equal((response.headers.get('location') || '').includes('private-error-description'), false);
    await f.request(`/api/oauth/oauth/callback?state=${state}&code=code`, { headers: { cookie } });
  }
  assert.equal(exchanges, 0);
  assert.equal(f.store.credential('oauth'), null);
});

test('OAuth exchange failures use a safe redirect and cannot be replayed', async (t) => {
  let exchanges = 0;
  const secret = 'private-exchange-token';
  const f = await fixture(t, { exchangeOAuthCode: async () => { exchanges++; throw new Error(`Unexpected ${secret}`); } });
  const cookie = await f.login();
  const { url } = await (await f.mutation('/api/oauth/oauth/start', undefined, cookie)).json() as { url: string };
  const state = new URL(url).searchParams.get('state');
  const path = `/api/oauth/oauth/callback?state=${state}&code=code`;
  const failed = await f.request(path, { headers: { cookie } });
  assert.equal(failed.status, 302);
  assert.match(failed.headers.get('location') || '', /error=/);
  assert.equal(decodeURIComponent(failed.headers.get('location') || '').includes(secret), false);
  await f.request(path, { headers: { cookie } });
  assert.equal(exchanges, 1);
  assert.equal(f.store.credential('oauth'), null);
});

test('unknown routes, unsupported providers, missing connections, and incorrect auth modes are rejected', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  assert.equal((await f.request('/api/not-real', { headers: { cookie } })).status, 404);
  assert.equal((await f.mutation('/api/connections/unknown/api-key', { apiKey: 'token' }, cookie)).status, 404);
  assert.equal((await f.mutation('/api/connections/openai/verify', undefined, cookie)).status, 404);
  assert.equal((await f.mutation('/api/oauth/openai/start', undefined, cookie)).status, 400);
  assert.equal((await f.mutation('/api/connections/oauth/api-key', { apiKey: 'token' }, cookie)).status, 400);
  const malformed = await f.request('/api/connections/openai/api-key', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-connector-request': '1', cookie }, body: '{broken-json',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'The request body must be valid JSON.' });
});

test('OAuth refuses missing server configuration before generating authorization state', async (t) => {
  let authorizeCalls = 0;
  const f = await fixture(t, {
    getProviderSetup: () => ({ configured: false, missing: ['OAUTH_CLIENT_ID'] }),
    createOAuthRequest: () => { authorizeCalls++; return 'https://authorization.example'; },
  });
  const cookie = await f.login();
  const response = await f.mutation('/api/oauth/oauth/start', undefined, cookie);
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /OAUTH_CLIENT_ID/);
  assert.equal(authorizeCalls, 0);
});

test('repeated incorrect passwords are rate limited', async (t) => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await f.mutation('/api/login', { password: 'incorrect-password' })).status, 401);
  }
  const blocked = await f.mutation('/api/login', { password: 'incorrect-password' });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
  assert.equal(blocked.headers.has('set-cookie'), false);
});
