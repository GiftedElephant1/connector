import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthRequest, exchangeOAuthCode, getProviderSetup, providerCatalog, refreshCredential, verifyConnection } from '../server/providers';
import { pinterestAdsAdapter } from '../server/providers-pinterest-ads';
import { ProviderError } from '../server/provider-types';

const env = { PINTEREST_ADS_CLIENT_ID: 'ads-client', PINTEREST_ADS_CLIENT_SECRET: 'ads-secret', PINTEREST_CLIENT_ID: 'organic-client', PINTEREST_CLIENT_SECRET: 'organic-secret' };
const input = { env, state: 'unpredictable-state', codeVerifier: 'unused-pkce-verifier', redirectUri: 'https://connector.example/api/oauth/pinterest-ads/callback', code: 'one-time-code' };

test('Pinterest Ads is a separate OAuth advertising connection with dedicated setup and ads-only scopes', () => {
  assert.equal(providerCatalog.find(provider => provider.id === 'pinterest-ads')?.category, 'advertising');
  assert.equal(providerCatalog.find(provider => provider.id === 'pinterest')?.category, 'social');
  assert.deepEqual(getProviderSetup('pinterest-ads', { PINTEREST_CLIENT_ID: 'organic-client', PINTEREST_CLIENT_SECRET: 'organic-secret' }), {
    configured: false, missing: ['PINTEREST_ADS_CLIENT_ID', 'PINTEREST_ADS_CLIENT_SECRET'],
  });
  const url = new URL(createOAuthRequest('pinterest-ads', input));
  assert.equal(url.origin + url.pathname, 'https://www.pinterest.com/oauth/');
  assert.equal(url.searchParams.get('client_id'), env.PINTEREST_ADS_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), input.redirectUri);
  assert.equal(url.searchParams.get('state'), input.state);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'ads:read,ads:write');
  assert.ok(!url.href.includes(env.PINTEREST_ADS_CLIENT_SECRET));
  assert.equal(new URL(createOAuthRequest('pinterest', input)).searchParams.get('scope')?.includes('ads:'), false);
});

test('Pinterest Ads exchanges and refreshes using its own Basic credentials and continuous refresh', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(url, 'https://api.pinterest.com/v5/oauth/token');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Basic ${Buffer.from('ads-client:ads-secret').toString('base64')}`);
    assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.has('client_secret'), false);
    assert.equal(body.get('continuous_refresh'), 'true');
    if (requests === 1) {
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), input.code);
      assert.equal(body.get('redirect_uri'), input.redirectUri);
      return Response.json({ access_token: 'first', refresh_token: 'refresh1', expires_in: 0, token_type: 'bearer' });
    }
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'refresh1');
    return Response.json({ access_token: 'second', refresh_token: 'refresh2', expires_in: 3600, token_type: 'bearer' });
  });
  const credential = await exchangeOAuthCode('pinterest-ads', input);
  const refreshed = await refreshCredential('pinterest-ads', { ...credential, expiresAt: Date.now() - 1 }, env);
  assert.equal(refreshed.accessToken, 'second');
  assert.equal(refreshed.refreshToken, 'refresh2');
  assert.ok(refreshed.expiresAt! > Date.now());
  assert.equal(requests, 2);
});

test('Pinterest Ads discovers owned/shared accounts without exposing provider private fields or following bookmarks', async t => {
  const request = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, 'https://api.pinterest.com/v5/ad_accounts?page_size=100');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ads-token');
    assert.equal(init?.redirect, 'error');
    return Response.json({ items: [
      { id: '123456789', name: 'Vectre Pay', owner: { username: 'private-owner' }, currency: 'USD' },
      { id: '234567891', name: 'Partner account', permissions: ['ANALYST'] },
      { id: '123456789', name: 'Vectre Pay' },
    ], bookmark: 'https://untrusted.example/private' });
  });
  const result = await verifyConnection('pinterest-ads', { accessToken: 'ads-token' }, env);
  assert.deepEqual(result.resources, [
    { id: '123456789', name: 'Vectre Pay', type: 'ad_account' },
    { id: '234567891', name: 'Partner account', type: 'ad_account' },
  ]);
  assert.equal(request.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(result), /private-owner|ads-token|untrusted/);
});

test('Pinterest Ads account previews are bounded and empty accounts are valid', async t => {
  let items: unknown[] = Array.from({ length: 150 }, (_, index) => ({ id: String(index + 1), name: `Account ${index + 1}` }));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ items }));
  assert.equal((await verifyConnection('pinterest-ads', { accessToken: 'token' }, env)).resources.length, 100);
  items = [];
  assert.deepEqual((await verifyConnection('pinterest-ads', { accessToken: 'token' }, env)).resources, []);
});

test('Pinterest Ads rejects malformed account responses and hides upstream failures', async t => {
  let body: unknown;
  let status = 200;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status }));
  for (const invalid of [{}, { items: [null] }, { items: [{ id: '../private' }] }, { items: [{ id: Number.MAX_SAFE_INTEGER + 1 }] }]) {
    body = invalid;
    await assert.rejects(verifyConnection('pinterest-ads', { accessToken: 'token' }, env), ProviderError);
  }
  status = 403;
  body = { code: 7, message: 'private-upstream-token' };
  await assert.rejects(verifyConnection('pinterest-ads', { accessToken: 'token' }, env), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 403);
    assert.ok(!error.message.includes('private-upstream-token'));
    return true;
  });
});

test('Pinterest Ads missing setup and refresh token fail before any provider request', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(exchangeOAuthCode('pinterest-ads', { ...input, env: {} }), /configuration/);
  await assert.rejects(pinterestAdsAdapter.refresh!({ accessToken: 'expired' }, env), /Reconnect Pinterest Ads/);
  assert.equal(request.mock.callCount(), 0);
});
