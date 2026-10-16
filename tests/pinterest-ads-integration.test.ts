import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { ActionDefinition } from '../server/action-types.ts';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { Store, type Connection } from '../server/store.ts';
import { WorkspaceAccounts } from '../server/workspace-accounts.ts';

const realFetch = globalThis.fetch;
const accountId = '987654321';
const campaignId = '456789012';
const adAccount = { id: accountId, name: 'Vectre Pay advertising', currency: 'USD' };
const organicCredential = { accessToken: 'private-organic-pinterest-token', refreshToken: 'private-organic-refresh' };
const adsCredential = { accessToken: 'private-ads-pinterest-token', refreshToken: 'private-ads-refresh' };

async function fixture(t: TestContext, connected = false) {
  const config: AppConfig = {
    origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000,
    password: 'private-pinterest-owner-password', encryptionKey: Buffer.alloc(32, 64),
    databasePath: ':memory:', secureCookies: false, pipelineKey: 'private-pinterest-pipeline-key-'.repeat(3),
  };
  const env = {
    PINTEREST_CLIENT_ID: 'organic-pinterest-app', PINTEREST_CLIENT_SECRET: 'private-organic-app-secret',
    PINTEREST_ADS_CLIENT_ID: 'advertising-pinterest-app', PINTEREST_ADS_CLIENT_SECRET: 'private-ads-app-secret',
  };
  const store = new Store(':memory:', config.encryptionKey);
  const organic = store.save('pinterest', organicCredential, {
    accountId: 'pinterest-member', accountName: 'Vectre Pay', resources: [{ id: 'pinterest-member', name: 'Vectre Pay', type: 'profile' }],
  });
  const connectAds = () => store.save('pinterest-ads', adsCredential, {
    accountName: 'Pinterest advertising access', resources: [{ id: accountId, name: adAccount.name, type: 'ad_account' }],
  });
  const previousAds = connected ? connectAds() : null;
  const app = createApp(config, store, undefined, env);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = `connector_session=${store.createSession()}`;
  const request = (path: string, init: RequestInit = {}) => realFetch(`${base}${path}`, { redirect: 'manual', ...init });
  const ownerMutation = (path: string, body: unknown, method = 'POST') => request(path, {
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
  const start = async () => {
    const response = await ownerMutation('/api/oauth/pinterest-ads/start', {});
    assert.equal(response.status, 200);
    const url = new URL((await response.json() as { url: string }).url);
    assert.equal(url.origin + url.pathname, 'https://www.pinterest.com/oauth/');
    assert.equal(url.searchParams.get('client_id'), env.PINTEREST_ADS_CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), `${config.origin}/api/oauth/pinterest-ads/callback`);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.deepEqual(url.searchParams.get('scope')?.split(',').sort(), ['ads:read', 'ads:write']);
    assert.equal(url.searchParams.has('client_secret'), false);
    assert.ok(url.searchParams.get('state'));
    return url.searchParams.get('state')!;
  };
  const callback = (state: string, suffix = 'code=private-ads-authorization-code', sessionCookie = cookie) => request(
    `/api/oauth/pinterest-ads/callback?state=${state}&${suffix}`, { headers: { cookie: sessionCookie } },
  );
  const assertOrganicUnchanged = () => {
    assert.deepEqual(store.connection('pinterest'), organic);
    assert.deepEqual(store.credential('pinterest'), organicCredential);
  };
  return { config, env, store, cookie, request, ownerMutation, api, rpc, start, callback, connectAds, previousAds, assertOrganicUnchanged };
}

type UpstreamCall = { url: URL; method: string; authorization: string | null; body: unknown };
function mockPinterest(t: TestContext, handler: (call: UpstreamCall) => Response | Promise<Response>) {
  const calls: UpstreamCall[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://api.pinterest.com', 'credentials must remain on the official Pinterest API');
    assert.equal(init?.redirect, 'error');
    const call = { url, method: init?.method || 'GET', authorization: new Headers(init?.headers).get('authorization'), body: init?.body };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

test('Pinterest Ads has a separate advertising setup and completes OAuth without replacing the organic account', async t => {
  const f = await fixture(t);
  const calls = mockPinterest(t, call => {
    if (call.url.pathname === '/v5/oauth/token') {
      assert.equal(call.method, 'POST');
      assert.equal(call.authorization, `Basic ${Buffer.from(`${f.env.PINTEREST_ADS_CLIENT_ID}:${f.env.PINTEREST_ADS_CLIENT_SECRET}`).toString('base64')}`);
      const form = new URLSearchParams(String(call.body));
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code'), 'private-ads-authorization-code');
      assert.equal(form.get('redirect_uri'), `${f.config.origin}/api/oauth/pinterest-ads/callback`);
      assert.equal(form.get('continuous_refresh'), 'true');
      return Response.json({ access_token: adsCredential.accessToken, refresh_token: adsCredential.refreshToken, expires_in: 3600, scope: 'ads:read,ads:write' });
    }
    assert.equal(call.url.pathname, '/v5/ad_accounts');
    assert.equal(call.url.searchParams.get('page_size'), '100');
    assert.equal(call.authorization, `Bearer ${adsCredential.accessToken}`);
    assert.equal(call.method, 'GET');
    return Response.json({ items: [adAccount] });
  });
  const setupResponse = await f.request('/api/settings/providers/pinterest-ads', { headers: { cookie: f.cookie } });
  assert.equal(setupResponse.status, 200);
  const setup = await setupResponse.json() as { fields: { key: string; value?: string }[] };
  assert.deepEqual(setup.fields.map(field => field.key).sort(), ['PINTEREST_ADS_CLIENT_ID', 'PINTEREST_ADS_CLIENT_SECRET']);
  assert.equal(setup.fields.find(field => field.key === 'PINTEREST_ADS_CLIENT_SECRET')?.value, undefined);
  const state = await f.start();
  const response = await f.callback(state);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/?connected=pinterest-ads');
  assert.deepEqual(f.store.connection('pinterest-ads')?.resources, [{ id: accountId, name: adAccount.name, type: 'ad_account' }]);
  assert.equal(f.store.credential('pinterest-ads')?.accessToken, adsCredential.accessToken);
  assert.equal(f.store.credential('pinterest-ads')?.refreshToken, adsCredential.refreshToken);
  f.assertOrganicUnchanged();

  const catalog = await (await f.request('/api/providers', { headers: { cookie: f.cookie } })).json() as { providers: { id: string; category: string; callbackUrl: string; connection: Connection; actions: ActionDefinition[] }[] };
  const advertising = catalog.providers.find(provider => provider.id === 'pinterest-ads')!;
  const organic = catalog.providers.find(provider => provider.id === 'pinterest')!;
  assert.equal(advertising.category, 'advertising');
  assert.equal(organic.category, 'social');
  assert.equal(advertising.callbackUrl, `${f.config.origin}/api/oauth/pinterest-ads/callback`);
  assert.equal(organic.callbackUrl, `${f.config.origin}/api/oauth/pinterest/callback`);
  assert.ok(advertising.actions.some(action => action.id === 'read-spend'));
  assert.ok(organic.actions.every(action => action.id !== 'read-spend'));
  assert.equal(f.store.jobs().length, 0);
  const beforeReplay = calls.length;
  const replay = await f.callback(state);
  assert.match(replay.headers.get('location')!, /^\/\?error=/);
  assert.equal(calls.length, beforeReplay, 'consumed authorization codes must not be sent to Pinterest again');
});

for (const failure of ['declined', 'wrong-session', 'token-rejected', 'ad-account-denied'] as const) {
  test(`Pinterest Ads ${failure} consent preserves existing ads and organic connections`, async t => {
    const f = await fixture(t, true);
    const calls = mockPinterest(t, call => {
      assert.ok(failure === 'token-rejected' || failure === 'ad-account-denied', 'bad state or declined consent must not reach Pinterest');
      if (call.url.pathname === '/v5/oauth/token') {
        return failure === 'token-rejected'
          ? Response.json({ message: 'private-provider-detail private-ads-app-secret' }, { status: 401 })
          : Response.json({ access_token: 'private-unverified-replacement-token', expires_in: 3600, scope: 'ads:read,ads:write' });
      }
      assert.equal(call.url.pathname, '/v5/ad_accounts');
      return Response.json({ message: 'private-unverified-replacement-token private-provider-detail' }, { status: 403 });
    });
    const state = await f.start();
    const response = await f.callback(state, failure === 'declined' ? 'error=access_denied' : undefined,
      failure === 'wrong-session' ? `connector_session=${f.store.createSession()}` : undefined);
    assert.equal(response.status, 302);
    const error = new URL(response.headers.get('location')!, f.config.origin).searchParams.get('error');
    assert.ok(error);
    assert.doesNotMatch(error, /private-provider-detail|private-unverified-replacement-token|private-ads-app-secret/);
    assert.equal(calls.length, failure === 'token-rejected' ? 1 : failure === 'ad-account-denied' ? 2 : 0);
    assert.deepEqual(f.store.connection('pinterest-ads'), f.previousAds);
    assert.deepEqual(f.store.credential('pinterest-ads'), adsCredential);
    f.assertOrganicUnchanged();
    assert.equal(f.store.jobs().length, 0);
  });
}

test('Pinterest Ads appears to Grok through REST and MCP and cannot borrow an organic token or Workspace profile key', async t => {
  const f = await fixture(t);
  const calls = mockPinterest(t, () => { throw new Error('Discovery and rejected credential boundaries must make no upstream request.'); });
  const response = await f.api('/api/v1/connections');
  assert.equal(response.status, 200);
  const text = await response.text();
  const listing = JSON.parse(text) as { connections: { provider: string; status: string; actions: { id: string; kind: string }[] }[] };
  const organic = listing.connections.find(connection => connection.provider === 'pinterest')!;
  const advertising = listing.connections.find(connection => connection.provider === 'pinterest-ads')!;
  assert.equal(organic.status, 'connected');
  assert.equal(advertising.status, 'not_connected');
  assert.deepEqual(advertising.actions.map(action => [action.id, action.kind]).sort(), [
    ['create-campaign', 'write'], ['list-campaigns', 'read'], ['read-spend', 'read'], ['set-campaign-budget', 'write'], ['set-campaign-status', 'write'],
  ].sort());
  const discovery = await (await f.rpc('list_actions', { provider: 'pinterest-ads' })).json() as { result: { structuredContent: { actions: ActionDefinition[] } } };
  assert.equal(discovery.result.structuredContent.actions.find(action => action.id === 'create-campaign')?.kind, 'write');
  assert.equal((await f.api('/api/v1/actions/pinterest-ads/list-campaigns', { values: { accountId } })).status, 409);
  f.connectAds();
  const accounts = new WorkspaceAccounts(f.config, f.store, f.env);
  const scoped = accounts.createProfile({ name: 'Workspace-only agent', bindings: [] });
  assert.equal((await f.api('/api/v1/actions/pinterest-ads/list-campaigns', { values: { accountId } }, scoped.apiKey)).status, 403);
  const blocked = await (await f.rpc('run_action', { provider: 'pinterest-ads', action: 'list-campaigns', values: { accountId } }, scoped.apiKey)).json() as { error?: unknown; result?: { isError?: boolean } };
  assert.ok(blocked.error || blocked.result?.isError);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(text + JSON.stringify(discovery), /private-organic-pinterest-token|private-ads-pinterest-token|private-ads-app-secret/);
  f.assertOrganicUnchanged();
});

test('Grok can list Pinterest campaigns and read spend through real REST and MCP routes using only the Ads token', async t => {
  const f = await fixture(t, true);
  const calls = mockPinterest(t, call => {
    assert.equal(call.authorization, `Bearer ${adsCredential.accessToken}`);
    assert.equal(call.method, 'GET', 'connecting and reading advertising must never create campaigns or spend');
    assert.equal(call.body, undefined);
    if (call.url.pathname === `/v5/ad_accounts/${accountId}`) return Response.json(adAccount);
    if (call.url.pathname === `/v5/ad_accounts/${accountId}/campaigns`) return Response.json({ items: [{ id: campaignId, ad_account_id: accountId, name: 'Vectre Pay brand campaign', status: 'PAUSED' }] });
    assert.equal(call.url.pathname, `/v5/ad_accounts/${accountId}/analytics`);
    assert.equal(call.url.searchParams.get('start_date'), '2026-10-01');
    assert.equal(call.url.searchParams.get('end_date'), '2026-10-02');
    assert.equal(call.url.searchParams.get('granularity'), 'DAY');
    return Response.json([{ AD_ACCOUNT_ID: accountId, DATE: '2026-10-01', SPEND_IN_MICRO_DOLLAR: 1250000, PAID_IMPRESSION: 200, OUTBOUND_CLICK_1: 4 }]);
  });
  const campaigns = await f.api('/api/v1/actions/pinterest-ads/list-campaigns', { values: { accountId } });
  assert.equal(campaigns.status, 200);
  const campaignsText = await campaigns.text();
  assert.match(campaignsText, /Vectre Pay brand campaign/);
  const report = await (await f.rpc('run_action', { provider: 'pinterest-ads', action: 'read-spend', values: { accountId, startDate: '2026-10-01', endDate: '2026-10-02' } })).json() as {
    result: { isError?: boolean; structuredContent: { result: { items: Record<string, unknown>[] }; job?: unknown } };
  };
  assert.notEqual(report.result.isError, true);
  assert.equal(report.result.structuredContent.job, undefined);
  assert.equal(report.result.structuredContent.result.items.length, 1);
  assert.equal(report.result.structuredContent.result.items[0].spend, '1.25');
  assert.equal(report.result.structuredContent.result.items[0].currency, 'USD');
  assert.equal(f.store.jobs().length, 0);
  assert.ok(calls.some(call => call.url.pathname.endsWith('/campaigns')));
  assert.ok(calls.some(call => call.url.pathname.endsWith('/analytics')));
  assert.doesNotMatch(campaignsText + JSON.stringify(report), /private-ads-pinterest-token|private-organic-pinterest-token|private-ads-app-secret/);
  f.assertOrganicUnchanged();
});

test('Pinterest campaign writes require explicit approval and repeated REST/MCP submissions share one receipt', async t => {
  const f = await fixture(t, true);
  const calls = mockPinterest(t, call => {
    assert.equal(call.authorization, `Bearer ${adsCredential.accessToken}`);
    if (call.url.pathname === `/v5/ad_accounts/${accountId}`) {
      assert.equal(call.method, 'GET');
      return Response.json(adAccount);
    }
    assert.equal(call.url.pathname, `/v5/ad_accounts/${accountId}/campaigns`);
    assert.equal(call.method, 'POST');
    const body = JSON.parse(String(call.body)) as Record<string, unknown>[];
    assert.equal(body.length, 1);
    assert.equal(body[0].ad_account_id, accountId);
    assert.equal(body[0].status, 'PAUSED', 'an approved create request must not start ad delivery');
    assert.equal(body[0].daily_spend_cap, 25_000_000);
    return Response.json({ items: [{ data: { ...body[0], id: campaignId }, exceptions: [] }] });
  });
  const actions = [
    { action: 'create-campaign', values: { accountId, name: 'Vectre Pay planned campaign', dailyBudget: '25', currency: 'USD' } },
    { action: 'set-campaign-status', values: { accountId, campaignId, status: 'ACTIVE' } },
    { action: 'set-campaign-budget', values: { accountId, campaignId, dailyBudget: '50', currency: 'USD' } },
  ];
  for (const [index, input] of actions.entries()) {
    const requestId = `pinterest-unconfirmed-${index}`;
    assert.equal((await f.api(`/api/v1/actions/pinterest-ads/${input.action}`, { values: input.values, requestId })).status, 409);
    const denied = await (await f.rpc('run_action', { provider: 'pinterest-ads', ...input, requestId })).json() as { result: { isError?: boolean } };
    assert.equal(denied.result.isError, true);
  }
  assert.equal(calls.length, 0, 'unapproved writes must not even read upstream account details');
  assert.equal(f.store.jobs().length, 0);

  const approved = { provider: 'pinterest-ads', ...actions[0], confirmed: true, requestId: 'pinterest-approved-create-1' };
  const created = await f.api('/api/v1/tools/run_action', approved);
  assert.equal(created.status, 200);
  assert.equal((await created.json() as { job: { status: string } }).job.status, 'succeeded');
  const afterCreate = calls.length;
  const retried = await (await f.rpc('run_action', approved)).json() as { result: { isError?: boolean; structuredContent: { job: { status: string } } } };
  assert.notEqual(retried.result.isError, true);
  assert.equal(retried.result.structuredContent.job.status, 'succeeded');
  assert.equal(calls.length, afterCreate, 'retrying the same approved request through MCP must not duplicate the campaign');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  const changed = await f.api('/api/v1/tools/run_action', { ...approved, values: { ...approved.values, dailyBudget: '100' } });
  assert.equal(changed.status, 409, 'an approved receipt must not authorize a different campaign budget');
  assert.equal(calls.length, afterCreate);
  assert.equal(f.store.jobs().length, 1);
  f.assertOrganicUnchanged();
});

test('an expired Pinterest Ads token refreshes with Ads app credentials before the real pipeline reads campaigns', async t => {
  const f = await fixture(t, true);
  f.store.updateCredential('pinterest-ads', { ...adsCredential, expiresAt: 1 });
  const calls = mockPinterest(t, call => {
    if (call.url.pathname === '/v5/oauth/token') {
      assert.equal(call.method, 'POST');
      assert.equal(call.authorization, `Basic ${Buffer.from(`${f.env.PINTEREST_ADS_CLIENT_ID}:${f.env.PINTEREST_ADS_CLIENT_SECRET}`).toString('base64')}`);
      const form = new URLSearchParams(String(call.body));
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), adsCredential.refreshToken);
      assert.equal(form.get('continuous_refresh'), 'true');
      return Response.json({ access_token: 'private-refreshed-ads-token', refresh_token: 'private-rotated-ads-refresh', expires_in: 3600 });
    }
    assert.equal(call.url.pathname, `/v5/ad_accounts/${accountId}/campaigns`);
    assert.equal(call.method, 'GET');
    assert.equal(call.authorization, 'Bearer private-refreshed-ads-token');
    return Response.json({ items: [] });
  });
  const response = await f.api('/api/v1/actions/pinterest-ads/list-campaigns', { values: { accountId } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { result: { items: unknown[] } }).result.items, []);
  assert.equal(calls.length, 2);
  assert.equal(f.store.credential('pinterest-ads')?.accessToken, 'private-refreshed-ads-token');
  assert.equal(f.store.credential('pinterest-ads')?.refreshToken, 'private-rotated-ads-refresh');
  assert.equal(f.store.jobs().length, 0);
  f.assertOrganicUnchanged();
});
