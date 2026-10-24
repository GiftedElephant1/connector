import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { ActionDefinition } from '../server/action-types.ts';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { Store } from '../server/store.ts';
import { WorkspaceAccounts } from '../server/workspace-accounts.ts';

const realFetch = globalThis.fetch;
const profileId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const adAccountId = '33333333-3333-4333-8333-333333333333';
const campaignId = '44444444-4444-4444-8444-444444444444';
const mediaId = '55555555-5555-4555-8555-555555555555';
const profileCredential = { accessToken: 'private-snapchat-profile-token', refreshToken: 'private-snapchat-profile-refresh' };
const adsCredential = { accessToken: 'private-snapchat-ads-token', refreshToken: 'private-snapchat-ads-refresh' };
const unrelatedCredential = { accessToken: 'private-retained-wordpress-token' };
const credentials = { snapchat: profileCredential, 'snapchat-ads': adsCredential };
type SnapchatProvider = keyof typeof credentials;
const scopes = { snapchat: 'snapchat-profile-api', 'snapchat-ads': 'snapchat-marketing-api' };
const secretPattern = /private-(?:snapchat|retained|provider|replacement|authorization)[A-Za-z0-9-]*/;

async function fixture(t: TestContext, connected = false) {
  const directory = mkdtempSync(join(tmpdir(), 'connector-snapchat-integration-'));
  const databasePath = join(directory, 'connections.sqlite');
  const config: AppConfig = {
    origin: 'https://connector.example', host: '127.0.0.1', port: 3000,
    password: 'private-owner-password', encryptionKey: Buffer.alloc(32, 102),
    databasePath, secureCookies: false, pipelineKey: 'snapchat-pipeline-key-'.repeat(3),
  };
  const env: NodeJS.ProcessEnv = {
    SNAPCHAT_CLIENT_ID: 'profile-client', SNAPCHAT_CLIENT_SECRET: 'private-snapchat-profile-secret',
    SNAPCHAT_ADS_CLIENT_ID: 'ads-client', SNAPCHAT_ADS_CLIENT_SECRET: 'private-snapchat-ads-secret',
  };
  const store = new Store(databasePath, config.encryptionKey);
  const unrelated = store.save('wordpress', unrelatedCredential, { accountName: 'Unrelated account', accountId: 'kept', resources: [] });
  const connect = (provider: SnapchatProvider) => store.save(provider, credentials[provider], {
    accountName: provider === 'snapchat' ? 'Vectre Pay Public Profile' : 'Vectre Pay advertising',
    resources: [{ id: provider === 'snapchat' ? profileId : adAccountId, name: 'Vectre Pay', type: provider === 'snapchat' ? 'public_profile' : 'ad_account' }],
  });
  if (connected) { connect('snapchat'); connect('snapchat-ads'); }
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
  const owner = (path: string, body: unknown = {}, method = 'POST') => request(path, {
    method, headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify(body),
  });
  const api = (path: string, body?: unknown, key = config.pipelineKey!) => request(path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let rpcId = 0;
  const rpc = (name: string, args: unknown, key = config.pipelineKey!) => request('/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const start = async (provider: SnapchatProvider) => {
    const response = await owner(`/api/oauth/${provider}/start`);
    assert.equal(response.status, 200, await response.clone().text());
    const url = new URL((await response.json()).url);
    assert.equal(url.origin + url.pathname, 'https://accounts.snapchat.com/login/oauth2/authorize');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), provider === 'snapchat' ? env.SNAPCHAT_CLIENT_ID : env.SNAPCHAT_ADS_CLIENT_ID);
    assert.equal(url.searchParams.get('scope'), scopes[provider]);
    assert.equal(url.searchParams.get('redirect_uri'), `${config.origin}/api/oauth/${provider}/callback`);
    assert.equal(url.searchParams.has('client_secret'), false);
    assert.ok(url.searchParams.get('state'));
    return url.searchParams.get('state')!;
  };
  const callback = (provider: SnapchatProvider, state: string, query = 'code=private-authorization-code', sessionCookie = cookie) => request(`/api/oauth/${provider}/callback?state=${encodeURIComponent(state)}&${query}`, { headers: { cookie: sessionCookie } });
  const assertUnrelated = () => {
    assert.deepEqual(store.credential('wordpress'), unrelatedCredential);
    assert.deepEqual(store.connection('wordpress'), unrelated);
  };
  return { config, env, store, directory, databasePath, session, cookie, request, owner, api, rpc, start, callback, connect, assertUnrelated };
}

type Call = { url: URL; method: string; headers: Headers; body: BodyInit | null | undefined };
function mockSnap(t: TestContext, handle: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.ok(['https://accounts.snapchat.com', 'https://adsapi.snapchat.com', 'https://businessapi.snapchat.com'].includes(url.origin), 'credentials and uploads must stay on official Snapchat endpoints');
    assert.equal(init?.redirect, 'error');
    const call = { url, method: init?.method || 'GET', headers: new Headers(init?.headers), body: init?.body };
    calls.push(call);
    return handle(call);
  });
  return calls;
}

function token(provider: SnapchatProvider, suffix = '') {
  return Response.json({ access_token: `${credentials[provider].accessToken}${suffix}`, refresh_token: `${credentials[provider].refreshToken}${suffix}`, expires_in: 3600, token_type: 'Bearer', scope: scopes[provider] });
}

function verification(provider: SnapchatProvider) {
  return provider === 'snapchat'
    ? Response.json({ request_status: 'SUCCESS', public_profile: { id: profileId, display_name: 'Vectre Pay', username: 'vectrepay' } })
    : Response.json({ request_status: 'SUCCESS', organizations: [{ sub_request_status: 'SUCCESS', organization: { id: organizationId, name: 'Vectre Pay', ad_accounts: [{ id: adAccountId, name: 'Vectre Pay Ads', currency: 'USD' }] } }] });
}

function assertVerificationCall(call: Call, provider: SnapchatProvider, accessToken = credentials[provider].accessToken) {
  assert.equal(call.method, 'GET');
  assert.equal(call.body, undefined);
  assert.equal(call.headers.get('authorization'), `Bearer ${accessToken}`);
  if (provider === 'snapchat') {
    assert.equal(call.url.origin, 'https://businessapi.snapchat.com');
    assert.equal(call.url.pathname, '/v1/public_profiles/my_profile');
  } else {
    assert.equal(call.url.origin, 'https://adsapi.snapchat.com');
    assert.equal(call.url.pathname, '/v1/me/organizations');
    assert.equal(call.url.searchParams.get('with_ad_accounts'), 'true');
  }
}

test('Snapchat public-profile and advertising authorization use distinct credentials, scopes, callbacks and encrypted tokens', async t => {
  const f = await fixture(t);
  let active: SnapchatProvider = 'snapchat';
  const calls = mockSnap(t, call => {
    if (call.url.origin === 'https://accounts.snapchat.com') {
      assert.equal(call.url.pathname, '/login/oauth2/access_token');
      assert.equal(call.method, 'POST');
      const form = new URLSearchParams(String(call.body));
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code'), 'private-authorization-code');
      assert.equal(form.get('client_id'), active === 'snapchat' ? f.env.SNAPCHAT_CLIENT_ID : f.env.SNAPCHAT_ADS_CLIENT_ID);
      assert.equal(form.get('client_secret'), active === 'snapchat' ? f.env.SNAPCHAT_CLIENT_SECRET : f.env.SNAPCHAT_ADS_CLIENT_SECRET);
      assert.equal(form.get('redirect_uri'), `${f.config.origin}/api/oauth/${active}/callback`);
      return token(active);
    }
    assertVerificationCall(call, active);
    return verification(active);
  });
  for (const provider of ['snapchat', 'snapchat-ads'] as const) {
    active = provider;
    const state = await f.start(provider);
    const callback = await f.callback(provider, state);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), `/?connected=${provider}`);
    assert.equal(f.store.credential(provider)?.accessToken, credentials[provider].accessToken);
    assert.equal(f.store.credential(provider)?.refreshToken, credentials[provider].refreshToken);
    const count = calls.length;
    const replay = await f.callback(provider, state);
    assert.match(replay.headers.get('location')!, /^\/\?error=/);
    assert.equal(calls.length, count, 'consumed OAuth state must never reuse the code upstream');
  }
  const catalog = await (await f.request('/api/providers', { headers: { cookie: f.cookie } })).json();
  const organic = catalog.providers.find((entry: { id: string }) => entry.id === 'snapchat');
  const advertising = catalog.providers.find((entry: { id: string }) => entry.id === 'snapchat-ads');
  assert.equal(organic.category, 'social');
  assert.equal(advertising.category, 'advertising');
  assert.ok(organic.actions.some((action: ActionDefinition) => action.id === 'publish-story'));
  assert.ok(advertising.actions.some((action: ActionDefinition) => action.id === 'create-campaign'));
  assert.doesNotMatch(JSON.stringify(catalog), secretPattern);
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT provider, secret, summary FROM connections WHERE provider IN ('snapchat', 'snapchat-ads')").all();
    assert.equal(rows.length, 2);
    assert.doesNotMatch(JSON.stringify(rows), secretPattern);
    assert.notEqual(rows[0].secret, rows[1].secret);
  } finally { db.close(); }
  f.assertUnrelated();
});

for (const provider of ['snapchat', 'snapchat-ads'] as const) {
  for (const failure of ['declined', 'wrong-session', 'wrong-provider', 'exchange', 'verification'] as const) {
    test(`${provider} ${failure} OAuth failure preserves both existing connections`, async t => {
      const f = await fixture(t, true);
      const before = f.store.connection(provider);
      const calls = mockSnap(t, call => {
        assert.ok(failure === 'exchange' || failure === 'verification');
        if (call.url.origin === 'https://accounts.snapchat.com') {
          return failure === 'exchange'
            ? Response.json({ error: 'invalid_client', error_description: 'private-provider-detail private-snapchat-ads-secret' }, { status: 401 })
            : token(provider, '-replacement');
        }
        return Response.json({ request_status: 'ERROR', error: 'private-replacement-token private-provider-detail' }, { status: 403 });
      });
      const state = await f.start(provider);
      const response = await f.callback(failure === 'wrong-provider' ? provider === 'snapchat' ? 'snapchat-ads' : 'snapchat' : provider, state,
        failure === 'declined' ? 'error=access_denied' : undefined,
        failure === 'wrong-session' ? `connector_session=${f.store.createSession()}` : undefined);
      assert.equal(response.status, 302);
      const error = new URL(response.headers.get('location')!, f.config.origin).searchParams.get('error');
      assert.ok(error);
      assert.doesNotMatch(error, secretPattern);
      assert.equal(calls.length, failure === 'exchange' ? 1 : failure === 'verification' ? 2 : 0);
      assert.deepEqual(f.store.connection(provider), before);
      assert.deepEqual(f.store.credential('snapchat'), profileCredential);
      assert.deepEqual(f.store.credential('snapchat-ads'), adsCredential);
      f.assertUnrelated();
    });
  }
}

for (const provider of ['snapchat', 'snapchat-ads'] as const) {
  test(`${provider} refresh uses its own app registration and rotates only its token`, async t => {
    const f = await fixture(t, true);
    const other: SnapchatProvider = provider === 'snapchat' ? 'snapchat-ads' : 'snapchat';
    f.store.updateCredential(provider, { ...credentials[provider], expiresAt: 1 });
    const calls = mockSnap(t, call => {
      if (call.url.origin === 'https://accounts.snapchat.com') {
        const form = new URLSearchParams(String(call.body));
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('refresh_token'), credentials[provider].refreshToken);
        assert.equal(form.get('client_id'), provider === 'snapchat' ? f.env.SNAPCHAT_CLIENT_ID : f.env.SNAPCHAT_ADS_CLIENT_ID);
        assert.equal(form.get('client_secret'), provider === 'snapchat' ? f.env.SNAPCHAT_CLIENT_SECRET : f.env.SNAPCHAT_ADS_CLIENT_SECRET);
        return token(provider, '-rotated');
      }
      assertVerificationCall(call, provider, `${credentials[provider].accessToken}-rotated`);
      return verification(provider);
    });
    const response = await f.owner(`/api/connections/${provider}/verify`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.doesNotMatch(await response.text(), secretPattern);
    assert.equal(calls.length, 2);
    assert.equal(f.store.credential(provider)?.refreshToken, `${credentials[provider].refreshToken}-rotated`);
    assert.deepEqual(f.store.credential(other), credentials[other]);
    f.assertUnrelated();
  });

  test(`resetting ${provider} clears only that Snapchat connection and its settings`, async t => {
    const f = await fixture(t, true);
    const other: SnapchatProvider = provider === 'snapchat' ? 'snapchat-ads' : 'snapchat';
    for (const id of ['snapchat', 'snapchat-ads']) f.store.saveOAuth(`${id}-pending`, f.session, id, 'unused-verifier');
    const calls = mockSnap(t, () => { throw new Error('Local reset must not invoke Snapchat.'); });
    const plan = await (await f.request(`/api/connections/${provider}/reset`, { headers: { cookie: f.cookie } })).json();
    assert.deepEqual(plan.affectedProviders.map((item: { id: string }) => item.id), [provider]);
    assert.equal((await f.owner(`/api/connections/${provider}/reset`, { confirmed: true })).status, 200);
    assert.equal(f.store.credential(provider), null);
    assert.equal(f.store.takeOAuth(`${provider}-pending`, f.session, provider), null);
    assert.deepEqual(f.store.credential(other), credentials[other]);
    assert.ok(f.store.takeOAuth(`${other}-pending`, f.session, other));
    assert.equal(f.env[provider === 'snapchat' ? 'SNAPCHAT_CLIENT_SECRET' : 'SNAPCHAT_ADS_CLIENT_SECRET'], '');
    assert.ok(f.env[other === 'snapchat' ? 'SNAPCHAT_CLIENT_SECRET' : 'SNAPCHAT_ADS_CLIENT_SECRET']);
    assert.equal(calls.length, 0);
    f.assertUnrelated();
  });
}

test('Snapchat content and advertising tools are independently discoverable through REST and MCP', async t => {
  const f = await fixture(t);
  f.connect('snapchat');
  const calls = mockSnap(t, () => { throw new Error('Discovery and authorization rejection must not invoke Snapchat.'); });
  const response = await f.api('/api/v1/connections');
  assert.equal(response.status, 200);
  const listing = await response.json();
  const organic = listing.connections.find((entry: { provider: string }) => entry.provider === 'snapchat');
  const ads = listing.connections.find((entry: { provider: string }) => entry.provider === 'snapchat-ads');
  assert.equal(organic.status, 'connected');
  assert.equal(ads.status, 'not_connected');
  assert.ok(organic.actions.some((action: ActionDefinition) => action.id === 'publish-story'));
  assert.ok(organic.actions.some((action: ActionDefinition) => action.id === 'publish-spotlight'));
  assert.ok(ads.actions.some((action: ActionDefinition) => action.id === 'read-spend'));
  const schemas = await (await f.rpc('list_actions', { provider: 'snapchat' })).json();
  assert.ok(schemas.result.structuredContent.actions.some((action: ActionDefinition) => action.id === 'publish-story' && action.schedulable));
  assert.equal((await f.api('/api/v1/actions/snapchat-ads/list-campaigns', { values: { accountId: adAccountId } })).status, 409);
  const scoped = new WorkspaceAccounts(f.config, f.store, f.env).createProfile({ name: 'Workspace-only agent', bindings: [] });
  assert.equal((await f.api('/api/v1/connections', undefined, scoped.apiKey)).status, 403);
  assert.doesNotMatch(JSON.stringify(listing) + JSON.stringify(schemas), secretPattern);
  assert.equal(calls.length, 0);
});

test('organization selection verifies the company Public Profile without borrowing Ads authorization', async t => {
  const f = await fixture(t, true);
  f.env.SNAPCHAT_ORGANIZATION_ID = organizationId;
  const calls = mockSnap(t, call => {
    assert.equal(call.url.origin, 'https://businessapi.snapchat.com');
    assert.equal(call.url.pathname, `/v1/organizations/${organizationId}/public_profiles`);
    assert.equal(call.url.searchParams.get('limit'), '100');
    assert.equal(call.headers.get('authorization'), `Bearer ${profileCredential.accessToken}`);
    return Response.json({ request_status: 'SUCCESS', public_profiles: [{ sub_request_status: 'SUCCESS', public_profile: { id: profileId, display_name: 'Vectre Pay company profile', organization_id: organizationId } }] });
  });
  const response = await f.owner('/api/connections/snapchat/verify');
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.store.connection('snapchat')?.accountId, organizationId);
  assert.deepEqual(f.store.connection('snapchat')?.resources, [{ id: profileId, name: 'Vectre Pay company profile', type: 'public_profile' }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(f.store.credential('snapchat-ads'), adsCredential);
});

function storyValues(size = 32 * 1024) {
  // Deterministic binary transport fixture: actual Snapchat media validation is
  // outside this offline test. The bytes exceed the old owner's 24 KiB JSON cap.
  const bytes = Buffer.alloc(size, 0x61);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  return { bytes, values: { profileId, name: 'Approved brand Story', media: `data:image/png;base64,${bytes.toString('base64')}`, link: '' } };
}

function storyApi(t: TestContext, expected: Uint8Array) {
  let key: Buffer, iv: Buffer;
  const uploadPath = `/us/v1/public_profiles/${profileId}/media/${mediaId}/multipart-upload`;
  return mockSnap(t, async call => {
    assert.equal(call.url.origin, 'https://businessapi.snapchat.com');
    assert.equal(call.headers.get('authorization'), `Bearer ${profileCredential.accessToken}`);
    assert.equal(call.method, 'POST');
    if (call.url.pathname === `/v1/public_profiles/${profileId}/media`) {
      const body = JSON.parse(String(call.body));
      assert.equal(body.type, 'IMAGE');
      assert.equal(body.name, 'Approved brand Story');
      key = Buffer.from(body.key, 'base64');
      iv = Buffer.from(body.iv, 'base64');
      assert.equal(key.length, 32);
      assert.equal(iv.length, 16);
      return Response.json({ request_status: 'SUCCESS', media_id: mediaId, add_path: uploadPath, finalize_path: uploadPath });
    }
    if (call.url.pathname === uploadPath) {
      assert.ok(call.body instanceof FormData);
      if (call.body.get('action') === 'ADD') {
        assert.equal(call.body.get('part_number'), '1');
        const file = call.body.get('file');
        assert.ok(file instanceof Blob);
        const encrypted = Buffer.from(await file.arrayBuffer());
        assert.notDeepEqual(encrypted, Buffer.from(expected));
        const decipher = createDecipheriv('aes-256-cbc', key!, iv!);
        assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), Buffer.from(expected));
      } else {
        assert.equal(call.body.get('action'), 'FINALIZE');
        assert.equal(call.body.has('file'), false);
      }
      return Response.json({ request_status: 'SUCCESS' });
    }
    assert.equal(call.url.pathname, `/v1/public_profiles/${profileId}/stories`);
    assert.deepEqual(JSON.parse(String(call.body)), { media_id: mediaId });
    return Response.json({ request_status: 'SUCCESS', request_id: 'snap-story-receipt' });
  });
}

test('authenticated owner can publish media above 24 KiB; encryption and cross-transport retry preserve one Story', async t => {
  const f = await fixture(t, true);
  const { bytes, values } = storyValues();
  const calls = storyApi(t, bytes);
  const body = { values, confirmed: true, requestId: 'snapchat-approved-story-1' };
  const path = '/api/actions/snapchat/publish-story';
  const rawBody = JSON.stringify(body);
  assert.ok(Buffer.byteLength(rawBody) > 24 * 1024);
  // Session and mutation checks must precede the larger authenticated body parser.
  const malformedLargeJson = `{${'x'.repeat(32 * 1024)}`;
  assert.equal((await f.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-connector-request': '1' }, body: malformedLargeJson })).status, 401);
  assert.equal((await f.request(path, { method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json' }, body: malformedLargeJson })).status, 403);
  assert.equal((await f.owner(path, { ...body, confirmed: false })).status, 409);
  assert.equal(calls.length, 0);
  assert.equal(f.store.jobs().length, 0);
  const response = await f.owner(path, body);
  assert.equal(response.status, 200, await response.clone().text());
  const receipt = await response.json();
  assert.equal(receipt.job.status, 'succeeded');
  assert.equal(receipt.result.items[0].status, 'accepted', 'API acceptance must not be promoted to final Snapchat visibility');
  assert.equal(calls.length, 4);
  assert.doesNotMatch(JSON.stringify(receipt), secretPattern);
  assert.equal(JSON.stringify(receipt).includes(values.media), false);
  const retry = await (await f.rpc('run_action', { provider: 'snapchat', action: 'publish-story', ...body })).json();
  assert.notEqual(retry.result.isError, true);
  assert.equal(retry.result.structuredContent.job.status, 'succeeded');
  assert.equal(calls.length, 4, 'same approved request through MCP must not upload or post again');
  assert.equal((await f.api('/api/v1/actions/snapchat/publish-story', { ...body, values: { ...values, name: 'Different story' } })).status, 409);
  assert.equal(calls.length, 4);
  assert.deepEqual(f.store.credential('snapchat-ads'), adsCredential);
  f.assertUnrelated();
});

test('Snapchat rejects oversized media without upload and permits scheduling the full media for a future fresh upload', async t => {
  const f = await fixture(t, true);
  const calls = mockSnap(t, () => { throw new Error('Validation and scheduling must not upload or publish now.'); });
  const oversized = storyValues(20 * 1024 * 1024 + 1).values;
  const response = await f.api('/api/v1/actions/snapchat/publish-story', { values: oversized, confirmed: true, requestId: 'snapchat-oversized-story' });
  assert.ok(response.status >= 400);
  assert.match((await response.json()).error, /20 MiB/);
  assert.equal(f.store.job('snapchat-oversized-story')?.status, 'failed');
  assert.equal(calls.length, 0);
  const values = storyValues().values;
  const scheduledAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const scheduled = await f.api('/api/v1/tools/schedule_post', { provider: 'snapchat', action: 'publish-story', values, scheduledAt, confirmed: true, requestId: 'snapchat-scheduled-story' });
  assert.equal(scheduled.status, 200, await scheduled.clone().text());
  assert.equal((await scheduled.json()).job.status, 'pending');
  assert.equal(f.store.jobValues('snapchat-scheduled-story').media, values.media, 'retain file bytes so execution can create fresh media rather than a 24-hour media ID');
  assert.equal(calls.length, 0);
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM jobs WHERE id = ?').all('snapchat-scheduled-story');
    assert.equal(JSON.stringify(rows).includes(values.media), false, 'scheduled file bytes must stay encrypted at rest');
  } finally { db.close(); }
});

test('Snapchat Ads campaign creation is confirmed, paused and idempotent across REST and MCP', async t => {
  const f = await fixture(t, true);
  const values = { accountId: adAccountId, name: 'Vectre Pay planned campaign', dailyBudget: '25', currency: 'USD' };
  const calls = mockSnap(t, call => {
    assert.equal(call.url.origin, 'https://adsapi.snapchat.com');
    assert.equal(call.headers.get('authorization'), `Bearer ${adsCredential.accessToken}`);
    if (call.url.pathname === `/v1/adaccounts/${adAccountId}`) {
      assert.equal(call.method, 'GET');
      return Response.json({ request_status: 'SUCCESS', adaccounts: [{ sub_request_status: 'SUCCESS', adaccount: { id: adAccountId, currency: 'USD', timezone: 'America/Los_Angeles' } }] });
    }
    assert.equal(call.method, 'POST');
    assert.equal(call.url.pathname, `/v1/adaccounts/${adAccountId}/campaigns`);
    const body = JSON.parse(String(call.body));
    assert.equal(body.campaigns.length, 1);
    assert.equal(body.campaigns[0].ad_account_id, adAccountId);
    assert.equal(body.campaigns[0].status, 'PAUSED');
    assert.equal(body.campaigns[0].daily_budget_micro, 25_000_000);
    return Response.json({ request_status: 'SUCCESS', campaigns: [{ sub_request_status: 'SUCCESS', campaign: { ...body.campaigns[0], id: campaignId } }] });
  });
  const input = { provider: 'snapchat-ads', action: 'create-campaign', values, requestId: 'snapchat-approved-campaign' };
  assert.equal((await f.api('/api/v1/tools/run_action', input)).status, 409);
  const rejected = await (await f.rpc('run_action', input)).json();
  assert.equal(rejected.result.isError, true);
  assert.equal(calls.length, 0);
  const response = await f.api('/api/v1/tools/run_action', { ...input, confirmed: true });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.job.status, 'succeeded');
  assert.equal(result.result.items[0].status, 'PAUSED');
  const after = calls.length;
  const retry = await (await f.rpc('run_action', { ...input, confirmed: true })).json();
  assert.notEqual(retry.result.isError, true);
  assert.equal(calls.length, after);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal((await f.api('/api/v1/tools/run_action', { ...input, confirmed: true, values: { ...values, dailyBudget: '200' } })).status, 409);
  assert.equal(calls.length, after);
  assert.deepEqual(f.store.credential('snapchat'), profileCredential);
  f.assertUnrelated();
});
