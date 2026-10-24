import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapchatAdsAdapter as adapter } from '../server/providers-snapchat-ads';
import { ProviderError } from '../server/provider-types';

const env = { SNAPCHAT_ADS_CLIENT_ID: 'snap-advertising-client', SNAPCHAT_ADS_CLIENT_SECRET: 'private-secret+&=%/' };
const input = { env, redirectUri: 'https://connector.example/api/oauth/snapchat-ads/callback', code: 'private-code', state: 'fresh-state', codeVerifier: 'unused-verifier' };
const accountId = '12345678-1234-1234-1234-123456789012';
const organizationId = 'aaaaaaaa-1234-1234-1234-123456789012';
const organizationEnvelope = (organizations: Record<string, unknown>[]) => ({ request_status: 'SUCCESS', organizations: organizations.map(organization => ({ sub_request_status: 'SUCCESS', organization })) });
const accountEnvelope = (accounts: unknown[]) => ({ request_status: 'success', adaccounts: accounts.map(adaccount => ({ sub_request_status: 'success', adaccount })) });
const envelope = (accounts: unknown[]) => ({ request_status: 'SUCCESS', organizations: [{ sub_request_status: 'SUCCESS', organization: { id: 'aaaaaaaa-1234-1234-1234-123456789012', ad_accounts: accounts } }] });
const response = () => ({ access_token: 'private-ads-token', refresh_token: 'private-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'snapchat-marketing-api' });

test('Snapchat Ads requests Marketing API scope and its dedicated app credentials only', () => {
  assert.deepEqual(adapter.requiredEnv, ['SNAPCHAT_ADS_CLIENT_ID', 'SNAPCHAT_ADS_CLIENT_SECRET']);
  const url = new URL(adapter.authorize!(input));
  assert.equal(url.origin + url.pathname, 'https://accounts.snapchat.com/login/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), env.SNAPCHAT_ADS_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), input.redirectUri);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), input.state);
  assert.equal(url.searchParams.get('scope'), 'snapchat-marketing-api');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.throws(() => adapter.authorize!({ ...input, env: { SNAPCHAT_CLIENT_ID: 'organic-id', SNAPCHAT_CLIENT_SECRET: 'organic-secret' } }), ProviderError);
});

test('Snapchat Ads exchanges the code and refreshes using documented form fields without corrupting secret punctuation', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://accounts.snapchat.com/login/oauth2/access_token');
    assert.equal(init.redirect, 'error');
    assert.equal(init.method, 'POST');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
    assert.equal(headers.has('authorization'), false);
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get('client_id'), env.SNAPCHAT_ADS_CLIENT_ID);
    assert.equal(body.get('client_secret'), env.SNAPCHAT_ADS_CLIENT_SECRET);
    if (++count === 1) {
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), input.code);
      assert.equal(body.get('redirect_uri'), input.redirectUri);
      return Response.json(response());
    }
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'private-refresh');
    assert.equal(body.has('code'), false);
    return Response.json({ ...response(), access_token: 'private-new-access', refresh_token: 'private-rotated-refresh' });
  });
  const before = Date.now(), credential = await adapter.exchange!(input);
  assert.ok(credential.expiresAt! >= before + 3_600_000);
  assert.equal(credential.accessToken, 'private-ads-token');
  const fresh = await adapter.refresh!(credential, env);
  assert.equal(fresh.refreshToken, 'private-rotated-refresh');
  assert.equal(count, 2);
});

test('Snapchat Ads verifies only accessible ad-account metadata and rejects arbitrary pagination destinations', async t => {
  const call = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://adsapi.snapchat.com/v1/me/organizations?with_ad_accounts=true');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer private-ads-token');
    assert.equal(init.redirect, 'error');
    return Response.json({ ...envelope([{ id: accountId, name: 'Vectre Pay ads', roles: ['admin'], currency: 'USD', private: 'do-not-return' }, { id: accountId, name: 'Vectre Pay ads' }]), paging: { next_link: 'https://attacker.example/' } });
  });
  const result = await adapter.verify({ accessToken: 'private-ads-token' }, env);
  assert.deepEqual(result.resources, [{ id: accountId, name: 'Vectre Pay ads', type: 'ad_account' }]);
  assert.equal(JSON.stringify(result).includes('do-not-return'), false);
  assert.equal(call.mock.callCount(), 1);
});

test('Snapchat Ads preserves empty discovery as empty and bounds account summaries', async t => {
  let body: unknown = envelope([]);
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  assert.deepEqual((await adapter.verify({ accessToken: 'token' }, env)).resources, []);
  body = envelope(Array.from({ length: 101 }, (_, i) => ({ id: `12345678-1234-1234-1234-${String(i).padStart(12, '0')}`, name: `Account ${i}` })));
  const result = await adapter.verify({ accessToken: 'token' }, env);
  assert.equal(result.resources.length, 100);
  assert.match(result.accountName, /first 100/);
});

test('Snapchat Ads discovers mixed inline, omitted and null organization accounts through only documented routes', async t => {
  const secondOrganization = 'bbbbbbbb-1234-1234-1234-123456789012';
  const thirdOrganization = 'cccccccc-1234-1234-1234-123456789012';
  const otherAccount = 'dddddddd-1234-1234-1234-123456789012';
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer token');
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://adsapi.snapchat.com');
    paths.push(parsed.pathname + parsed.search);
    if (parsed.pathname === '/v1/me/organizations') return Response.json(organizationEnvelope([
      { id: organizationId, ad_accounts: [{ id: accountId, name: 'Inline account' }] },
      { id: secondOrganization },
      { id: thirdOrganization, ad_accounts: null },
      { id: secondOrganization },
    ]));
    if (parsed.pathname === `/v1/organizations/${secondOrganization}/adaccounts`) return Response.json({ ...accountEnvelope([{ id: otherAccount, organization_id: secondOrganization, name: 'Fallback account', currency: 'USD' }]), paging: { next_link: 'https://attacker.example/?token=private' } });
    assert.equal(parsed.pathname, `/v1/organizations/${thirdOrganization}/adaccounts`);
    return Response.json(accountEnvelope([]));
  });
  const result = await adapter.verify({ accessToken: 'token' }, env);
  assert.deepEqual(result.resources, [{ id: accountId, name: 'Inline account', type: 'ad_account' }, { id: otherAccount, name: 'Fallback account', type: 'ad_account' }]);
  assert.deepEqual(paths, ['/v1/me/organizations?with_ad_accounts=true', `/v1/organizations/${secondOrganization}/adaccounts`, `/v1/organizations/${thirdOrganization}/adaccounts`]);
});

test('Snapchat Ads preserves valid empty fallback discovery and never requests fallback for an empty inline list', async t => {
  let body: unknown = organizationEnvelope([{ id: organizationId, ad_accounts: null }]);
  const call = t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(url.includes('/me/organizations') ? body : accountEnvelope([])));
  assert.deepEqual((await adapter.verify({ accessToken: 'token' }, env)).resources, []);
  assert.equal(call.mock.callCount(), 2);
  body = envelope([]);
  assert.deepEqual((await adapter.verify({ accessToken: 'token' }, env)).resources, []);
  assert.equal(call.mock.callCount(), 3);
});

test('Snapchat Ads validates fallback UUIDs and inline shapes before sending any organization request', async t => {
  let body: unknown;
  const call = t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.ok(url.includes('/me/organizations'));
    return Response.json(body);
  });
  for (const invalid of [
    { id: '../private-token', ad_accounts: null },
    { id: 'https://attacker.example/private-token' },
    { id: organizationId, ad_accounts: {} },
    { id: organizationId, ad_accounts: [{ id: 'private-token' }] },
  ]) {
    body = organizationEnvelope([{ id: organizationId }, invalid]);
    await assert.rejects(adapter.verify({ accessToken: 'token' }, env), error => error instanceof ProviderError && /SNAP_ADS_ORGANIZATIONS_INVALID_/.test(error.message) && !error.message.includes('private-token'));
  }
  assert.equal(call.mock.callCount(), 4);
});

test('Snapchat Ads bounds fallback discovery to ten unique organization reads and fails clearly above the limit', async t => {
  let count = 11;
  const call = t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(url.includes('/me/organizations')
    ? organizationEnvelope(Array.from({ length: count }, (_, i) => ({ id: `aaaaaaaa-1234-1234-1234-${String(i).padStart(12, '0')}` })))
    : accountEnvelope([])));
  await assert.rejects(adapter.verify({ accessToken: 'token' }, env), /SNAP_ADS_ORGANIZATIONS_FALLBACK_LIMIT.*more than 10/);
  assert.equal(call.mock.callCount(), 1, 'preflight must fail before any fallback requests');
  count = 10;
  assert.deepEqual((await adapter.verify({ accessToken: 'token' }, env)).resources, []);
  assert.equal(call.mock.callCount(), 12);
});

test('Snapchat Ads reports sanitized nested discovery codes and rejects unexpected fallback envelopes', async t => {
  let body: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(url.includes('/me/organizations') ? organizationEnvelope([{ id: organizationId }]) : body));
  for (const [fault, expectedCode] of [
    [{ request_status: 'ERROR', error_code: 'E3001', display_message: 'private-token private-organization' }, 'E3001'],
    [{ request_status: 'SUCCESS', adaccounts: [{ sub_request_status: 'ERROR', sub_request_error_reason: 'Error code: E1165, message: private-token private-organization' }] }, 'E1165'],
    [{ request_status: 'ERROR', adaccounts: [{ sub_request_status: 'ERROR', sub_request_error_reason: 'Error code: E1165, message: private-token private-organization' }] }, 'E1165'],
    [{ request_status: 'SUCCESS', adaccounts: [{ sub_request_status: 'ERROR', sub_request_error_reason: 'E3001', display_message: 'private-token' }] }, 'E3001'],
    [{ request_status: 'ERROR', error_code: 126, display_message: 'private-token' }, '126'],
  ] as const) {
    body = fault;
    await assert.rejects(adapter.verify({ accessToken: 'token' }, env), error => error instanceof ProviderError && error.message.includes(`provider code ${expectedCode}`) && error.message.includes('SNAP_ADS_ADACCOUNTS_PROVIDER_REJECTED') && !/private-token|private-organization/.test(error.message));
  }
  for (body of [
    { request_status: 'ERROR', error_code: 'E123456789private-token' },
    { request_status: 'SUCCESS', adaccounts: [{ sub_request_status: 'ERROR', sub_request_error_reason: 'Error code: E123456789, message: private-token' }] },
    { request_status: 'SUCCESS', ad_accounts: [{ id: accountId }] },
    { request_status: 'SUCCESS', adaccounts: [{ sub_request_status: 'SUCCESS', ad_account: { id: accountId } }] },
    accountEnvelope([{ id: 'private-token' }]),
  ]) await assert.rejects(adapter.verify({ accessToken: 'token' }, env), error => error instanceof ProviderError && /SNAP_ADS_ADACCOUNTS_/.test(error.message) && !/private-token|provider code/.test(error.message));
});

test('Snapchat Ads discovery HTTP and network errors identify the read without leaking upstream diagnostics', async t => {
  let phase: 'organizations' | 'fallback' = 'organizations';
  let status = 403;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (phase === 'fallback' && url.includes('/me/organizations')) return Response.json(organizationEnvelope([{ id: organizationId }]));
    if (!status) throw new Error('private-secret private-url');
    return Response.json({ error_code: 42, display_message: 'private-secret private-url' }, { status });
  });
  await assert.rejects(adapter.verify({ accessToken: 'token' }, env), error => error instanceof ProviderError && error.status === 403 && /HTTP 403.*SNAP_ADS_ORGANIZATIONS_HTTP_ERROR.*provider code 42/.test(error.message) && !error.message.includes('private-'));
  phase = 'fallback'; status = 401;
  await assert.rejects(adapter.verify({ accessToken: 'token' }, env), error => error instanceof ProviderError && error.status === 401 && /HTTP 401.*SNAP_ADS_ADACCOUNTS_HTTP_ERROR/.test(error.message) && !error.message.includes('private-'));
  status = 0;
  await assert.rejects(adapter.verify({ accessToken: 'token' }, env), error => error instanceof ProviderError && /SNAP_ADS_ADACCOUNTS_NETWORK_ERROR/.test(error.message) && !error.message.includes('private-'));
});

test('Snapchat Ads rejects failed and malformed nested discovery responses including HTTP-200 failures', async t => {
  let body: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  for (body of [
    { ...envelope([]), request_status: 'ERROR', display_message: 'private-provider-details' },
    { request_status: 'SUCCESS', organizations: [{ sub_request_status: 'ERROR', sub_request_error_reason: 'private-provider-details', organization: { ad_accounts: [] } }] },
    { request_status: 'SUCCESS', organizations: [{ sub_request_status: 'SUCCESS', organization: { ad_accounts: [null] } }] },
    { request_status: 'SUCCESS', organizations: [] },
  ]) {
    if (JSON.stringify(body) === JSON.stringify({ request_status: 'SUCCESS', organizations: [] })) {
      assert.deepEqual((await adapter.verify({ accessToken: 'token' }, env)).resources, []);
    } else await assert.rejects(adapter.verify({ accessToken: 'token' }, env), error => error instanceof ProviderError && !error.message.includes('private-provider-details'));
  }
});

test('Snapchat Ads rejects unrenewable and wrong-scope tokens and redacts HTTP failures', async t => {
  let body: unknown, status = 200;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status }));
  for (body of [
    { ...response(), scope: 'snapchat-profile-api' },
    { ...response(), refresh_token: '' },
    { ...response(), expires_in: 0 },
    { error: 'invalid_client', error_description: env.SNAPCHAT_ADS_CLIENT_SECRET },
  ]) await assert.rejects(adapter.exchange!(input), ProviderError);
  body = { error_description: 'private-secret private-token' }; status = 401;
  await assert.rejects(adapter.exchange!(input), error => error instanceof ProviderError && !/private-secret|private-token/.test(error.message));
});

test('Snapchat Ads validates refresh credentials before any network request', async t => {
  const call = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not call'); });
  for (const refreshToken of [undefined, '', 'bad\r\nvalue', 'x'.repeat(8193)]) assert.throws(() => adapter.refresh!({ accessToken: 'token', refreshToken }, env), ProviderError);
  assert.equal(call.mock.callCount(), 0);
});
