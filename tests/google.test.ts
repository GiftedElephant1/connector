import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { googleAdapters } from '../server/providers-google.ts';
import { ProviderError } from '../server/provider-types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const env = {
  GOOGLE_CLIENT_ID: 'example.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'test-developer-token',
};
const credential = { accessToken: 'test-access-token' };
const adapter = (id: string) => {
  const result = googleAdapters.find((item) => item.definition.id === id);
  assert.ok(result);
  return result;
};

function mockResource(body: unknown, inspect?: (url: string, init?: RequestInit) => void) {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-access-token');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      assert.equal(new Headers(init?.headers).has('developer-token'), false);
      return Response.json({ sub: 'google-user-123', email: 'owner@example.com' });
    }
    inspect?.(url, init);
    return Response.json(body);
  };
}

test('Google uses per-service scopes, state, PKCE S256, and offline access', () => {
  const scopes: Record<string, string> = {
    youtube: 'youtube.readonly https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly', 'google-ads': 'adwords',
    'google-analytics': 'analytics.readonly', 'search-console': 'webmasters.readonly',
  };
  for (const provider of googleAdapters) {
    const redirectUri = `http://localhost:3000/api/oauth/${provider.definition.id}/callback`;
    const url = new URL(provider.authorize!({ redirectUri, state: 'test-state', codeVerifier: 'test-verifier', env }));
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('scope'), `openid email https://www.googleapis.com/auth/${scopes[provider.definition.id]}`);
    assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(url.searchParams.get('state'), 'test-state');
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update('test-verifier').digest('base64url'));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.has('client_secret'), false);
    assert.equal(url.searchParams.get('include_granted_scopes'), null);
  }
});

test('Google exchanges the code with its matching PKCE verifier on the server', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const body = new URLSearchParams(init?.body as URLSearchParams);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'returned-code');
    assert.equal(body.get('code_verifier'), 'test-verifier');
    assert.equal(body.get('client_secret'), env.GOOGLE_CLIENT_SECRET);
    assert.equal(body.get('redirect_uri'), 'http://localhost:3000/api/oauth/youtube/callback');
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer' });
  };
  const result = await adapter('youtube').exchange!({
    code: 'returned-code', codeVerifier: 'test-verifier',
    redirectUri: 'http://localhost:3000/api/oauth/youtube/callback', env,
  });
  assert.equal(result.accessToken, 'new-access');
  assert.equal(result.refreshToken, 'new-refresh');
  assert.ok(result.expiresAt! > Date.now() + 3_500_000);
});

test('Google refresh preserves the prior refresh token when the response omits it', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init?.body as URLSearchParams);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'existing-refresh');
    assert.equal(body.get('client_id'), env.GOOGLE_CLIENT_ID);
    assert.equal(body.has('code_verifier'), false);
    return Response.json({ access_token: 'refreshed-access', expires_in: 3600 });
  };
  const result = await adapter('google-analytics').refresh!({ ...credential, refreshToken: 'existing-refresh' }, env);
  assert.equal(result.accessToken, 'refreshed-access');
  assert.equal(result.refreshToken, 'existing-refresh');
  await assert.rejects(adapter('youtube').refresh!(credential, env), /offline access/);
});

test('YouTube reads owned channels and labels the verified Google account', async () => {
  mockResource({ items: [{ id: 'channel-123', snippet: { title: 'My channel' }, private: 'discard' }] }, (url, init) => {
    assert.equal(url, 'https://youtube.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50');
    assert.equal(init?.method ?? 'GET', 'GET');
  });
  assert.deepEqual(await adapter('youtube').verify(credential, env), {
    accountId: 'google-user-123', accountName: 'owner@example.com',
    resources: [{ id: 'channel-123', name: 'My channel', type: 'YouTube channel' }],
  });
});

test('Google Ads sends the developer token only to the official Ads read endpoint', async () => {
  mockResource({ resourceNames: ['customers/1234567890', 'bad', null] }, (url, init) => {
    assert.equal(url, 'https://googleads.googleapis.com/v25/customers:listAccessibleCustomers');
    assert.equal(new Headers(init?.headers).get('developer-token'), env.GOOGLE_ADS_DEVELOPER_TOKEN);
    assert.equal(new Headers(init?.headers).has('login-customer-id'), false);
  });
  const result = await adapter('google-ads').verify(credential, env);
  assert.deepEqual(result.resources, [{ id: 'customers/1234567890', name: 'Google Ads customer 1234567890', type: 'Google Ads customer' }]);
});

test('Google Analytics includes accounts and GA4 properties from account summaries', async () => {
  mockResource({ accountSummaries: [{
    account: 'accounts/123', displayName: 'Team account',
    propertySummaries: [{ property: 'properties/456', displayName: 'Website' }],
  }] }, (url) => {
    assert.equal(url, 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=100');
  });
  const result = await adapter('google-analytics').verify(credential, env);
  assert.deepEqual(result.resources, [
    { id: 'accounts/123', name: 'Team account', type: 'Analytics account' },
    { id: 'properties/456', name: 'Website', type: 'GA4 property' },
  ]);
});

test('Search Console preserves property IDs and excludes unverified entries', async () => {
  mockResource({ siteEntry: [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://example.com/', permissionLevel: 'siteRestrictedUser' },
    { siteUrl: 'https://unverified.example/', permissionLevel: 'siteUnverifiedUser' },
    { siteUrl: 'https://missing-permission.example/' },
  ] }, (url) => assert.equal(url, 'https://searchconsole.googleapis.com/webmasters/v3/sites'));
  const result = await adapter('search-console').verify(credential, env);
  assert.deepEqual(result.resources.map((item) => item.id), ['sc-domain:example.com', 'https://example.com/']);
});

test('empty Google resource lists remain clearly identified as empty', async () => {
  // Protobuf JSON often omits a repeated field for an empty collection.
  mockResource({});
  for (const provider of googleAdapters) {
    const result = await provider.verify(credential, env);
    assert.deepEqual(result.resources, []);
    assert.match(result.accountName, /^owner@example.com \(no .+ returned\)$/);
  }
});

test('resource previews are bounded and pagination URLs are never followed', async () => {
  const bodies: Record<string, unknown> = {
    youtube: { items: Array.from({ length: 150 }, (_, i) => ({ id: `channel-${i}` })), nextPageToken: 'https://untrusted.example' },
    'google-ads': { resourceNames: Array.from({ length: 150 }, (_, i) => `customers/${i}`) },
    'google-analytics': { accountSummaries: [{ account: 'accounts/1', propertySummaries: Array.from({ length: 150 }, (_, i) => ({ property: `properties/${i}` })) }] },
    'search-console': { siteEntry: Array.from({ length: 150 }, (_, i) => ({ siteUrl: `sc-domain:${i}.example`, permissionLevel: 'siteOwner' })) },
  };
  for (const provider of googleAdapters) {
    let requests = 0;
    mockResource(bodies[provider.definition.id], () => { requests++; });
    const result = await provider.verify(credential, env);
    assert.equal(result.resources.length, provider.definition.id === 'youtube' ? 50 : 100);
    assert.equal(requests, 1);
  }
});

test('malformed responses, denied scopes, and upstream errors cannot create false verified accounts or leak secrets', async () => {
  mockResource({ items: 'not-a-list' });
  await assert.rejects(adapter('youtube').verify(credential, env), /unexpected resource list/);
  mockResource({ error: { message: 'secret-in-upstream-error' } });
  await assert.rejects(adapter('google-ads').verify(credential, env), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.message.includes('secret-in-upstream-error'), false);
    return true;
  });
  globalThis.fetch = async () => Response.json({ sub: 'user' }, { status: 403 });
  await assert.rejects(adapter('youtube').verify(credential, env), /denied access/);
  globalThis.fetch = async () => Response.json({ email: 'missing-sub@example.com' });
  await assert.rejects(adapter('youtube').verify(credential, env), /account identity/);
});

test('missing developer-token setup and invalid credentials fail before network requests', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({}); };
  await assert.rejects(adapter('google-ads').verify(credential, {}), /GOOGLE_ADS_DEVELOPER_TOKEN/);
  await assert.rejects(adapter('youtube').verify({ accessToken: 'bad\r\nheader' }, env), /valid API key/);
  assert.equal(requests, 0);
});
