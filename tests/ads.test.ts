import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { adsAdapters } from '../server/providers-ads.ts';
import { ProviderError } from '../server/provider-types.ts';

const adapter = (id: string) => adsAdapters.find((entry) => entry.definition.id === id)!;
const env: NodeJS.ProcessEnv = {
  LINKEDIN_CLIENT_ID: 'linkedin-client', LINKEDIN_CLIENT_SECRET: 'linkedin-secret',
  MICROSOFT_CLIENT_ID: 'microsoft-client', MICROSOFT_CLIENT_SECRET: 'microsoft-secret', MICROSOFT_ADS_DEVELOPER_TOKEN: 'developer-token',
  TIKTOK_BUSINESS_APP_ID: '12345', TIKTOK_BUSINESS_APP_SECRET: 'business-secret',
  REDDIT_ADS_CLIENT_ID: 'reddit-client', REDDIT_ADS_CLIENT_SECRET: 'reddit-secret', REDDIT_ADS_ACCOUNT_ID: 't2_adaccount',
};
const input = { env, code: 'one-use-code', redirectUri: 'https://connector.example/api/oauth/test/callback', state: 'random-state', codeVerifier: 'verifier-with-ample-entropy-for-a-test' };

test('advertising authorizations preserve state and request platform-specific permissions', () => {
  for (const id of ['linkedin-ads', 'microsoft-ads', 'tiktok-business', 'reddit-ads']) {
    const url = new URL(adapter(id).authorize!(input));
    assert.equal(url.searchParams.get('state'), input.state);
    assert.equal(url.searchParams.get('redirect_uri'), input.redirectUri);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.searchParams.has('client_secret'), false);
  }
  assert.equal(new URL(adapter('linkedin-ads').authorize!(input)).searchParams.get('scope'), 'r_ads rw_ads r_ads_reporting');
  assert.equal(new URL(adapter('reddit-ads').authorize!(input)).searchParams.get('scope'), 'adsread adsedit');
  assert.equal(new URL(adapter('linkedin-ads').authorize!({ ...input, env: { ...env, LINKEDIN_ENABLE_CONVERSIONS: 'true' } })).searchParams.get('scope'), 'r_ads rw_ads r_ads_reporting rw_conversions');
  const microsoft = new URL(adapter('microsoft-ads').authorize!(input));
  assert.equal(microsoft.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(microsoft.searchParams.get('code_challenge'), createHash('sha256').update(input.codeVerifier).digest('base64url'));
  assert.match(microsoft.searchParams.get('scope')!, /msads.manage/);
});

test('LinkedIn verifies advertising accounts using versioned REST, not profile access', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.linkedin.com/rest/adAccounts?q=search&count=100');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('linkedin-version'), '202609');
    assert.equal(headers.get('x-restli-protocol-version'), '2.0.0');
    assert.equal(headers.get('authorization'), 'Bearer linkedin-access');
    return Response.json({ elements: [{ id: 123, name: 'Acme campaigns' }] });
  });
  const result = await adapter('linkedin-ads').verify({ accessToken: 'linkedin-access' }, { ...env, LINKEDIN_API_VERSION: '202609' });
  assert.deepEqual(result.resources, [{ id: '123', name: 'Acme campaigns', type: 'ad_account' }]);
});

test('Microsoft GetUser verifies advertising roles and deduplicates account IDs', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13/User/Query');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), { UserId: null });
    assert.equal(new Headers(init.headers).get('developertoken'), env.MICROSOFT_ADS_DEVELOPER_TOKEN);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer microsoft-access');
    return Response.json({
      User: { Id: '100', Name: { FirstName: 'Ava', LastName: 'Chen' }, AuthenticationToken: 'must-not-escape' },
      CustomerRoles: [{ CustomerId: '200', AccountIds: ['300'], LinkedAccountIds: ['300', '400'] }],
    });
  });
  const result = await adapter('microsoft-ads').verify({ accessToken: 'microsoft-access' }, env);
  assert.equal(result.accountName, 'Ava Chen');
  assert.deepEqual(result.resources.map((resource) => resource.id), ['200', '300', '400']);
  assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
});

test('Microsoft refuses verification without a developer token before any network request', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not be called'); });
  await assert.rejects(adapter('microsoft-ads').verify({ accessToken: 'example' }, {}), /MICROSOFT_ADS_DEVELOPER_TOKEN/);
  assert.equal(request.mock.callCount(), 0);
});

test('Microsoft token exchange binds the code verifier and refresh preserves a nonrotated refresh token', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests++;
    assert.equal(url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
    const form = new URLSearchParams(String(init.body));
    if (requests === 1) {
      assert.equal(form.get('code_verifier'), input.codeVerifier);
      assert.equal(form.get('redirect_uri'), input.redirectUri);
      return Response.json({ access_token: 'first-token', refresh_token: 'refresh-token', expires_in: 3600 });
    }
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'refresh-token');
    return Response.json({ access_token: 'second-token', expires_in: 3600 });
  });
  const credential = await adapter('microsoft-ads').exchange!(input);
  const refreshed = await adapter('microsoft-ads').refresh!(credential, env);
  assert.equal(refreshed.accessToken, 'second-token');
  assert.equal(refreshed.refreshToken, 'refresh-token');
  assert.ok(refreshed.expiresAt! > Date.now());
});

test('TikTok business exchange uses auth_code and verification reads actual Business Centers', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests++;
    if (requests === 1) {
      assert.equal(url, 'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/');
      assert.deepEqual(JSON.parse(String(init.body)), { app_id: '12345', secret: 'business-secret', auth_code: input.code });
      return Response.json({ code: 0, data: { access_token: 'business-access' } });
    }
    assert.match(url, /^https:\/\/business-api\.tiktok\.com\/open_api\/v1\.3\/bc\/get\//);
    assert.equal(new Headers(init.headers).get('Access-Token'), 'business-access');
    return Response.json({ code: 0, data: { list: [{ bc_info: { bc_id: '42', name: 'Example business' } }] } });
  });
  const credential = await adapter('tiktok-business').exchange!(input);
  const result = await adapter('tiktok-business').verify(credential, env);
  assert.deepEqual(result.resources, [{ id: '42', name: 'Example business', type: 'business_center' }]);
});

test('TikTok HTTP 200 errors are rejected without exposing upstream details', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 40105, message: 'private-access-token', data: { list: [] } }));
  await assert.rejects(adapter('tiktok-business').verify({ accessToken: 'valid-input' }, env), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 403);
    assert.equal(error.message.includes('private-access-token'), false);
    return true;
  });
});

test('X Ads signs a user-context OAuth 1.0a request, including query parameters', async (t) => {
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://ads-api.x.com/12/accounts?count=1000');
    const header = new Headers(init.headers).get('authorization')!;
    assert.ok(header.startsWith('OAuth '));
    const oauth = Object.fromEntries(header.slice(6).split(', ').map((pair) => {
      const [key, value] = pair.split('=');
      return [key, decodeURIComponent(value.slice(1, -1))];
    }));
    assert.equal(oauth.oauth_token, 'user-token');
    assert.equal(oauth.oauth_consumer_key, 'consumer');
    const signatureInput = `count=1000&oauth_consumer_key=consumer&oauth_nonce=${oauth.oauth_nonce}&oauth_signature_method=HMAC-SHA1&oauth_timestamp=${oauth.oauth_timestamp}&oauth_token=user-token&oauth_version=1.0`;
    const signatureBase = `GET&${encode('https://ads-api.x.com/12/accounts')}&${encode(signatureInput)}`;
    const expected = createHmac('sha1', `${encode('consumer!secret')}&${encode('token/secret')}`).update(signatureBase).digest('base64');
    assert.equal(oauth.oauth_signature, expected);
    assert.equal(header.includes('consumer!secret'), false);
    return Response.json({ data: [{ id: 'abc', name: 'X advertiser' }] });
  });
  const result = await adapter('x-ads').verify({ accessToken: 'user-token', fields: { consumerKey: 'consumer', consumerSecret: 'consumer!secret', accessTokenSecret: 'token/secret' } }, {});
  assert.equal(result.resources[0].id, 'abc');
});

test('X Ads refuses a plain social bearer token', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not be called'); });
  await assert.rejects(adapter('x-ads').verify({ accessToken: 'social-token' }, {}), /consumer key/);
  assert.equal(request.mock.callCount(), 0);
});

test('Reddit Ads verifies a selected ad account even if it has no campaigns', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://ads-api.reddit.com/api/v3/ad_accounts/t2_adaccount/campaigns');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ads-token');
    return Response.json({ data: [], pagination: {} });
  });
  const result = await adapter('reddit-ads').verify({ accessToken: 'ads-token' }, env);
  assert.equal(result.accountId, 't2_adaccount');
  assert.equal(result.resources[0].type, 'ad_account');
});

test('expired advertising credentials without a refresh token require reconnecting', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not be called'); });
  for (const provider of ['linkedin-ads', 'microsoft-ads', 'reddit-ads']) {
    await assert.rejects(adapter(provider).refresh!({ accessToken: 'expired', expiresAt: Date.now() - 1 }, env), /expired.*Reconnect/);
  }
  assert.equal(request.mock.callCount(), 0);
});

test('Reddit Ads exchanges code with HTTP Basic client authentication', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://www.reddit.com/api/v1/access_token');
    assert.equal(new Headers(init.headers).get('authorization'), `Basic ${Buffer.from('reddit-client:reddit-secret').toString('base64')}`);
    assert.equal(new URLSearchParams(String(init.body)).get('code'), input.code);
    return Response.json({ access_token: 'ads-token', refresh_token: 'ads-refresh' });
  });
  assert.equal((await adapter('reddit-ads').exchange!(input)).refreshToken, 'ads-refresh');
});

test('a social profile response never passes advertising verification', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'a-user', name: 'Social profile' }));
  for (const provider of ['linkedin-ads', 'microsoft-ads', 'reddit-ads']) {
    await assert.rejects(adapter(provider).verify({ accessToken: 'example' }, env), ProviderError);
  }
});

test('approved-access rejection is surfaced without leaking upstream response', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'secret-credential' }, { status: 403 }));
  await assert.rejects(adapter('reddit-ads').verify({ accessToken: 'valid' }, env), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 403);
    assert.match(error.message, /permissions and app approval/);
    assert.equal(error.message.includes('secret-credential'), false);
    return true;
  });
});
