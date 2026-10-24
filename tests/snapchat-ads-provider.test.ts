import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapchatAdsAdapter as adapter } from '../server/providers-snapchat-ads';
import { ProviderError } from '../server/provider-types';

const env = { SNAPCHAT_ADS_CLIENT_ID: 'snap-advertising-client', SNAPCHAT_ADS_CLIENT_SECRET: 'private-secret+&=%/' };
const input = { env, redirectUri: 'https://connector.example/api/oauth/snapchat-ads/callback', code: 'private-code', state: 'fresh-state', codeVerifier: 'unused-verifier' };
const accountId = '12345678-1234-1234-1234-123456789012';
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
