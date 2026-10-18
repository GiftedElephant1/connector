import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tiktokAccountAdapter as adapter } from '../server/providers-tiktok-account.ts';
import { ProviderError, type Credential } from '../server/provider-types.ts';

const redirectUri = 'https://connector.example/api/oauth/tiktok-business-account/callback/';
const businessAppId = '8123456789012345678';
const portalClientKey = 'portal-client-key-distinct-from-business-id';
const secret = 'fixture-secret+&=%/';
const accessToken = 'fixture-account-access-token';
const refreshToken = 'fixture-account-refresh-token';
const openId = 'fixture-account-open-id';
const scope = 'user.info.basic,video.list';
const upstreamPrivateText = 'private-provider-message-with-fixture-secret';
const privateValues = [secret, accessToken, refreshToken, upstreamPrivateText];
const api = 'https://business-api.tiktok.com/open_api/v1.3/';

function portalUrl(callback = redirectUri): URL {
  const url = new URL('https://www.tiktok.com/v2/auth/authorize');
  url.search = new URLSearchParams({
    client_key: portalClientKey, scope, response_type: 'code', redirect_uri: callback,
  }).toString();
  return url;
}

function environment(url = portalUrl().toString()): NodeJS.ProcessEnv {
  return {
    TIKTOK_BUSINESS_APP_ID: businessAppId,
    TIKTOK_BUSINESS_APP_SECRET: secret,
    TIKTOK_BUSINESS_ACCOUNT_AUTH_URL: url,
  };
}

function authorize(env = environment(), callback = redirectUri): string {
  return adapter.authorize!({ env, redirectUri: callback, state: 'fresh-session-state', codeVerifier: 'unused-verifier' });
}

function exchange(env = environment(), callback = redirectUri) {
  return adapter.exchange!({ env, redirectUri: callback, code: 'fixture-one-time-code', codeVerifier: 'unused-verifier' });
}

function previousToken(): Credential {
  return { accessToken, refreshToken, tokenType: 'Bearer', fields: { openId, scope } };
}

function tokenData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: accessToken, refresh_token: refreshToken, expires_in: 86400,
    refresh_token_expires_in: 31536000, token_type: 'Bearer', open_id: openId, scope,
    ...overrides,
  };
}

function safeError(error: unknown): boolean {
  assert.ok(error instanceof ProviderError);
  for (const value of privateValues) assert.equal(error.message.includes(value), false, 'Error exposed private provider data');
  return true;
}

test('TikTok account holder preserves the portal client key and scopes while replacing state', () => {
  for (const path of ['/v2/auth/authorize', '/v2/auth/authorize/']) {
    const supplied = portalUrl();
    supplied.pathname = path;
    supplied.searchParams.set('state', 'old-portal-state');
    supplied.searchParams.set('disable_auto_auth', '0');
    const env = environment(supplied.toString());
    const result = new URL(authorize(env));
    assert.equal(result.origin, 'https://www.tiktok.com');
    assert.equal(result.pathname, path);
    assert.equal(result.searchParams.get('client_key'), portalClientKey);
    assert.notEqual(result.searchParams.get('client_key'), businessAppId);
    assert.equal(result.searchParams.get('scope'), scope);
    assert.equal(result.searchParams.get('redirect_uri'), redirectUri);
    assert.deepEqual(result.searchParams.getAll('state'), ['fresh-session-state']);
    assert.equal(result.searchParams.get('disable_auto_auth'), '1');
    assert.equal(env.TIKTOK_BUSINESS_ACCOUNT_AUTH_URL, supplied.toString());
  }
});

test('TikTok account holder rejects nonofficial authorization destinations and embedded credentials', () => {
  const invalid = [
    'https://www.tiktok.com.evil.example/v2/auth/authorize',
    'https://evil.example/v2/auth/authorize',
    'https://tiktok.com/v2/auth/authorize',
    'http://www.tiktok.com/v2/auth/authorize',
    'https://www.tiktok.com:444/v2/auth/authorize',
    'https://www.tiktok.com/other/path',
    'https://user:password@www.tiktok.com/v2/auth/authorize',
  ];
  for (const destination of invalid) {
    const url = new URL(destination);
    url.search = portalUrl().search;
    assert.throws(() => authorize(environment(url.toString())), safeError, destination);
  }
  const fragment = portalUrl();
  fragment.hash = 'private-fragment';
  assert.throws(() => authorize(environment(fragment.toString())), safeError);
  assert.throws(() => authorize(environment('not an authorization URL')), safeError);
});

test('TikTok account holder rejects secret query parameters, duplicates, and incomplete portal URLs', () => {
  for (const key of ['client_secret', 'secret', 'access_token', 'refresh_token', 'auth_code', 'unknown_parameter']) {
    const url = portalUrl();
    url.searchParams.set(key, secret);
    assert.throws(() => authorize(environment(url.toString())), safeError, key);
  }
  for (const key of ['client_key', 'scope', 'redirect_uri', 'response_type', 'state', 'disable_auto_auth']) {
    const url = portalUrl();
    url.searchParams.append(key, 'one');
    url.searchParams.append(key, 'two');
    assert.throws(() => authorize(environment(url.toString())), safeError, key);
  }
  for (const key of ['client_key', 'scope', 'redirect_uri', 'response_type']) {
    const url = portalUrl();
    url.searchParams.delete(key);
    assert.throws(() => authorize(environment(url.toString())), safeError, key);
  }
  const implicit = portalUrl();
  implicit.searchParams.set('response_type', 'token');
  assert.throws(() => authorize(environment(implicit.toString())), safeError);
});

test('TikTok account holder requires an exact HTTPS callback with trailing slash and no port or parameters', () => {
  for (const callback of [
    'not-a-url',
    redirectUri.slice(0, -1),
    redirectUri.replace('https:', 'http:'),
    redirectUri.replace('connector.example', 'connector.example:8443'),
    redirectUri.replace('connector.example', 'connector.example:443'),
    redirectUri.replace('connector.example', 'localhost'),
    `${redirectUri}?secret=${secret}`,
    `${redirectUri}#fragment`,
    redirectUri.replace('connector.example', 'user:password@connector.example'),
    `https://connector.example/${'x'.repeat(500)}/`,
  ]) {
    assert.throws(() => authorize(environment(portalUrl(callback).toString()), callback), safeError, callback);
  }
  assert.throws(() => authorize(environment(portalUrl('https://different.example/callback/').toString())), safeError);
});

test('TikTok account holder exchanges using Business credentials and verifies the returned account identity', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.has('authorization'), false);
    const body = JSON.parse(String(init?.body));
    if (url.endsWith('/tt_user/oauth2/token/')) {
      assert.deepEqual(body, {
        client_id: businessAppId, client_secret: secret, grant_type: 'authorization_code',
        auth_code: 'fixture-one-time-code', redirect_uri: redirectUri,
      });
      return Response.json({ code: 0, data: tokenData() });
    }
    assert.equal(url, `${api}tt_user/token_info/get/`);
    assert.deepEqual(body, { app_id: businessAppId, access_token: accessToken });
    return Response.json({ code: 0, data: { app_id: businessAppId, creator_id: openId, scope } });
  });
  const before = Date.now();
  const token = await exchange();
  assert.equal(token.accessToken, accessToken);
  assert.equal(token.refreshToken, refreshToken);
  assert.deepEqual(token.fields, { openId, scope });
  assert.ok(token.expiresAt! >= before + 86400000 && token.expiresAt! <= Date.now() + 86400000);
  const account = await adapter.verify(token, environment());
  assert.equal(account.accountId, openId);
  assert.deepEqual(account.resources, [{ id: openId, name: `TikTok account ${openId}`, type: 'tiktok_account' }]);
  assert.deepEqual(calls, [`${api}tt_user/oauth2/token/`, `${api}tt_user/token_info/get/`]);
});

test('TikTok account holder blocks code exchange if the saved portal redirect no longer matches', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not send the one-time code'); });
  await assert.rejects(exchange(environment(portalUrl('https://different.example/callback/').toString())), safeError);
  assert.equal(fetch.mock.callCount(), 0);
});

test('TikTok account holder rejects provider envelopes and malformed token data without exposing upstream text', async t => {
  let response: () => Response;
  t.mock.method(globalThis, 'fetch', async () => response());
  const runs = [() => exchange(), () => adapter.refresh!(previousToken(), environment()), () => adapter.verify(previousToken(), environment())];
  for (const body of [
    { code: 40102, message: upstreamPrivateText, data: tokenData() },
    { code: '0', message: upstreamPrivateText, data: tokenData() },
    { code: 0, data: null, message: upstreamPrivateText },
  ]) {
    response = () => Response.json(body);
    for (const run of runs) await assert.rejects(run(), safeError);
  }
  for (const status of [401, 403, 429, 500]) {
    response = () => Response.json({ message: upstreamPrivateText, access_token: accessToken }, { status });
    for (const run of runs) await assert.rejects(run(), safeError);
  }
  response = () => new Response(upstreamPrivateText);
  for (const run of runs) await assert.rejects(run(), safeError);
  for (const overrides of [
    { open_id: '' }, { open_id: 'line\nbreak' }, { open_id: 123 },
    { scope: null }, { scope: 'x'.repeat(8193) },
    { expires_in: 0 }, { expires_in: '86400' }, { access_token: '' }, { access_token: 'line\nbreak' },
  ]) {
    response = () => Response.json({ code: 0, data: tokenData(overrides), message: upstreamPrivateText });
    await assert.rejects(exchange(), safeError);
  }
});

test('TikTok account holder verification rejects mismatched apps and subjects', async t => {
  let result: Record<string, unknown>;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 0, data: result }));
  for (const overrides of [
    { app_id: 'different-business-app' }, { app_id: Number(businessAppId) },
    { creator_id: 'different-account' }, { creator_id: '' }, { scope: null },
  ]) {
    result = { app_id: businessAppId, creator_id: openId, scope, ...overrides };
    await assert.rejects(adapter.verify(previousToken(), environment()), safeError);
  }
  result = { app_id: businessAppId, creator_id: openId, scope };
  await assert.rejects(adapter.verify({ accessToken }, environment()), safeError);
});

test('TikTok account holder refresh preserves its subject and rotates or retains the refresh token', async t => {
  let refreshResponse = tokenData({ access_token: 'new-access-token', refresh_token: 'rotated-refresh-token' });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), `${api}tt_user/oauth2/refresh_token/`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      client_id: businessAppId, client_secret: secret, grant_type: 'refresh_token', refresh_token: refreshToken,
    });
    return Response.json({ code: 0, data: refreshResponse });
  });
  const rotated = await adapter.refresh!(previousToken(), environment());
  assert.equal(rotated.refreshToken, 'rotated-refresh-token');
  assert.equal(rotated.accessToken, 'new-access-token');
  assert.equal(rotated.fields?.openId, openId);
  refreshResponse = tokenData();
  delete refreshResponse.refresh_token;
  assert.equal((await adapter.refresh!(previousToken(), environment())).refreshToken, refreshToken);
  refreshResponse = tokenData({ open_id: 'different-account' });
  await assert.rejects(adapter.refresh!(previousToken(), environment()), error => {
    safeError(error);
    assert.match((error as ProviderError).message, /different account while refreshing/);
    return true;
  });
  await assert.rejects(adapter.refresh!({ accessToken, fields: { openId, scope } }, environment()), safeError);
});
