import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapchatAdapter as adapter } from '../server/providers-snapchat';
import { ProviderError } from '../server/provider-types';

const profileId = '76da494b-76bc-4bbb-bb27-c5a66fb0d1ab';
const organizationId = '40d6719b-da09-410b-9185-0cc9c0dfed1d';
const env = { SNAPCHAT_CLIENT_ID: 'profile-client', SNAPCHAT_CLIENT_SECRET: 'profile-secret+&%/=' };
const input = { env, redirectUri: 'https://connector.example/api/oauth/snapchat/callback', state: 'unguessable-session-state', codeVerifier: 'unused', code: 'one-use-code' };

test('Snapchat organic OAuth requests Public Profile access separately from advertising', () => {
  const url = new URL(adapter.authorize!(input));
  assert.equal(url.origin + url.pathname, 'https://accounts.snapchat.com/login/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), env.SNAPCHAT_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), input.redirectUri);
  assert.equal(url.searchParams.get('state'), input.state);
  assert.equal(url.searchParams.get('scope'), 'snapchat-profile-api');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.throws(() => adapter.authorize!({ ...input, env: { SNAPCHAT_ADS_CLIENT_ID: 'ads-client', SNAPCHAT_ADS_CLIENT_SECRET: 'ads-secret' } }), /Configure SNAPCHAT_CLIENT_ID/);
});

test('Snapchat form exchange preserves secret characters and refresh token rotation', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, 'https://accounts.snapchat.com/login/oauth2/access_token');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('client_id'), env.SNAPCHAT_CLIENT_ID);
    assert.equal(body.get('client_secret'), env.SNAPCHAT_CLIENT_SECRET);
    if (++calls === 1) {
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), input.code);
      assert.equal(body.get('redirect_uri'), input.redirectUri);
      return Response.json({ access_token: 'first-access', refresh_token: 'first-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'first-refresh');
    return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
  });
  const original = await adapter.exchange!(input);
  assert.ok(original.expiresAt! > Date.now());
  const next = await adapter.refresh!(original, env);
  assert.equal(next.accessToken, 'rotated-access');
  assert.equal(next.refreshToken, 'rotated-refresh');
  assert.equal(calls, 2);
});

test('Snapchat verifies the authorized user Public Profile with the official response shape', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, 'https://businessapi.snapchat.com/v1/public_profiles/my_profile');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer profile-token');
    return Response.json({ request_status: 'SUCCESS', public_profile: { id: profileId, display_name: 'Vectre Pay', organization_id: organizationId, private_extra_field: 'omit' } });
  });
  assert.deepEqual(await adapter.verify({ accessToken: 'profile-token' }, env), {
    accountId: profileId, accountName: 'Vectre Pay', resources: [{ id: profileId, name: 'Vectre Pay', type: 'public_profile' }],
  });
});

test('Snapchat can verify organization-owned profiles without selecting the personal profile', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, `https://businessapi.snapchat.com/v1/organizations/${organizationId}/public_profiles?limit=100`);
    return Response.json({ request_status: 'SUCCESS', public_profiles: [{ sub_request_status: 'SUCCESS', public_profile: { id: profileId, display_name: 'Vectre Pay' } }], paging: { next_link: 'https://untrusted.example/ignored' } });
  });
  const result = await adapter.verify({ accessToken: 'profile-token' }, { ...env, SNAPCHAT_ORGANIZATION_ID: organizationId });
  assert.equal(result.accountId, organizationId);
  assert.equal(result.resources[0].id, profileId);
});

test('Snapchat validates configuration and refresh credentials before network requests', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(adapter.verify({ accessToken: 'profile-token' }, { ...env, SNAPCHAT_ORGANIZATION_ID: '../other' }), /organization ID.*UUID/);
  assert.throws(() => adapter.refresh!({ accessToken: 'profile-token' }, env), /Reconnect Snapchat/);
  assert.equal(request.mock.callCount(), 0);
});

test('Snapchat rejects denied, partial, empty and malformed profile responses without leaking provider details', async t => {
  let response: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  for (const value of [
    { request_status: 'ERROR', debug_message: env.SNAPCHAT_CLIENT_SECRET },
    { request_status: 'PARTIAL', public_profile: { id: profileId }, debug_message: env.SNAPCHAT_CLIENT_SECRET },
    { request_status: 'SUCCESS' },
    { request_status: 'SUCCESS', public_profile: { id: '../bad' } },
  ]) {
    response = value;
    await assert.rejects(adapter.verify({ accessToken: 'profile-token' }, env), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(env.SNAPCHAT_CLIENT_SECRET), false);
      return true;
    });
  }
  for (const public_profiles of [[], [{ sub_request_status: 'ERROR', public_profile: { id: profileId } }], [{ public_profile: { id: profileId } }], null]) {
    response = { request_status: 'SUCCESS', public_profiles };
    await assert.rejects(adapter.verify({ accessToken: 'profile-token' }, { ...env, SNAPCHAT_ORGANIZATION_ID: organizationId }), ProviderError);
  }
});
