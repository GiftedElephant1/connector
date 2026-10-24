import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapchatAdsActions } from '../server/actions-snapchat-ads';
import { ProviderError } from '../server/provider-types';

const credential = { accessToken: 'private-advertising-token' };
const accountId = '11111111-1111-1111-1111-111111111111';
const campaignId = '22222222-2222-2222-2222-222222222222';
const otherId = '33333333-3333-3333-3333-333333333333';
const base = { accountId, campaignId, name: 'Vectre Pay launch', dailyBudget: '25.123456', currency: 'GBP', startTime: '2026-10-24T10:00:00+08:00' };
const existing = { id: campaignId, ad_account_id: accountId, name: base.name, status: 'PAUSED', daily_budget_micro: 25_123_456, lifetime_spend_cap_micro: 500_000_000 };
const envelope = (collection: string, entity: string, value: unknown) => ({ request_status: 'SUCCESS', [collection]: [{ sub_request_status: 'SUCCESS', [entity]: value }] });
const campaign = (value: unknown = existing) => envelope('campaigns', 'campaign', value);
const account = () => envelope('adaccounts', 'adaccount', { id: accountId, currency: 'GBP', timezone: 'Europe/London' });
const action = (id: string) => { const a = snapchatAdsActions.find(a => a.definition.id === id); assert.ok(a); return a; };
function request(input: string | URL | Request, init: RequestInit = {}) {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://adsapi.snapchat.com');
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${credential.accessToken}`);
  assert.equal(init.redirect, 'error');
  assert.equal(url.toString().includes(credential.accessToken), false);
  if (init.body !== undefined) assert.equal(new Headers(init.headers).get('content-type'), init.method === 'PATCH' ? 'application/json-patch+json' : 'application/json');
  return url;
}

test('Snapchat advertising writes are explicit spending operations and cannot be scheduled', () => {
  assert.deepEqual(snapchatAdsActions.map(a => [a.definition.id, a.definition.kind]), [
    ['list-ad-accounts', 'read'], ['list-campaigns', 'read'], ['create-campaign', 'write'], ['set-campaign-status', 'write'], ['set-campaign-budget', 'write'], ['read-spend', 'read'],
  ]);
  for (const a of snapchatAdsActions) { assert.equal(a.provider, 'snapchat-ads'); assert.equal(a.definition.schedulable, undefined); }
  assert.match(action('set-campaign-status').definition.description, /start spending/);
  assert.match(action('set-campaign-budget').definition.description, /spend more/);
});

test('Snapchat lists only chosen account campaigns and does not follow untrusted next links', async t => {
  const call = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = request(input, init);
    assert.equal(url.pathname, `/v1/adaccounts/${accountId}/campaigns`);
    assert.equal(url.search, '?limit=100&sort=updated_at-desc');
    return Response.json({ ...campaign(), paging: { next_link: 'https://attacker.example?token=private' } });
  });
  const result = await action('list-campaigns').execute(credential, { accountId }, {});
  assert.equal(result.items?.[0].id, campaignId);
  assert.equal(result.items?.[0].dailyBudgetMicros, '25123456');
  assert.match(result.summary, /More campaigns/);
  assert.equal(call.mock.callCount(), 1);
  assert.equal(JSON.stringify(result).includes('attacker'), false);
});

test('Snapchat creates exactly one paused auction campaign with precise account-currency cap', async t => {
  const call = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = request(input, init);
    if (url.pathname === `/v1/adaccounts/${accountId}`) { assert.equal(init?.method, 'GET'); return Response.json(account()); }
    assert.equal(url.pathname, `/v1/adaccounts/${accountId}/campaigns`);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { campaigns: [{
      name: base.name, ad_account_id: accountId, status: 'PAUSED', start_time: '2026-10-24T02:00:00.000Z', buy_model: 'AUCTION', creation_state: 'PUBLISHED',
      objective_v2_properties: { objective_v2_type: 'AWARENESS_AND_ENGAGEMENT' }, daily_budget_micro: 25_123_456, pacing_level: 'AD_SQUAD',
    }] });
    return Response.json(campaign());
  });
  const result = await action('create-campaign').execute(credential, { ...base, status: 'ACTIVE' }, {});
  assert.deepEqual(result.items, [{ id: campaignId, accountId, status: 'PAUSED', dailyBudget: '25.123456', dailyBudgetMicros: '25123456', currency: 'GBP' }]);
  assert.equal(call.mock.callCount(), 2);
});

test('Snapchat activation and pause use only targeted JSON Patch, never destructive PUT', async t => {
  const call = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = request(input, init);
    assert.equal(url.pathname, `/v1/adaccounts/${accountId}/campaigns/${campaignId}`);
    assert.equal(init?.method, 'PATCH');
    const patch = JSON.parse(String(init?.body));
    assert.deepEqual(patch, [{ op: 'replace', path: '/status', value: patch[0].value }]);
    return Response.json(campaign({ ...existing, status: patch[0].value }));
  });
  for (const status of ['ACTIVE', 'PAUSED']) assert.equal((await action('set-campaign-status').execute(credential, { accountId, campaignId, status }, {})).items?.[0].status, status);
  assert.equal(call.mock.callCount(), 2);
});

test('Snapchat changes a verified daily cap while preserving status and lifetime cap', async t => {
  const call = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = request(input, init);
    if (url.pathname === `/v1/adaccounts/${accountId}`) return Response.json(account());
    if (url.pathname === `/v1/campaigns/${campaignId}`) return Response.json(campaign({ ...existing, status: 'ACTIVE' }));
    assert.equal(url.pathname, `/v1/adaccounts/${accountId}/campaigns/${campaignId}`);
    assert.equal(init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(init?.body)), [{ op: 'replace', path: '/daily_budget_micro', value: 32_000_001 }]);
    return Response.json(campaign({ ...existing, status: 'ACTIVE', daily_budget_micro: 32_000_001 }));
  });
  const result = await action('set-campaign-budget').execute(credential, { ...base, dailyBudget: '32.000001' }, {});
  assert.equal(result.items?.[0].dailyBudget, '32.000001');
  assert.equal(call.mock.callCount(), 3);
});

test('Snapchat refuses currency mismatch, another account campaign and missing daily caps before writing', async t => {
  let currency = 'USD', row: Record<string, unknown> = existing;
  const call = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'GET');
    return Response.json(String(input).includes('/adaccounts/') ? envelope('adaccounts', 'adaccount', { id: accountId, currency }) : campaign(row));
  });
  await assert.rejects(action('create-campaign').execute(credential, base, {}), /Currency must match/);
  currency = 'GBP'; row = { ...existing, ad_account_id: otherId };
  await assert.rejects(action('set-campaign-budget').execute(credential, base, {}), ProviderError);
  row = { ...existing }; delete row.daily_budget_micro;
  await assert.rejects(action('set-campaign-budget').execute(credential, base, {}), /existing daily/);
  assert.equal(call.mock.callCount(), 5);
});

test('Snapchat rejects top-level and nested HTTP-200 failures and wrong write confirmations without leaking response text', async t => {
  let body: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  for (body of [
    { request_status: 'ERROR', display_message: 'private-provider-details private-advertising-token' },
    { request_status: 'SUCCESS', campaigns: [{ sub_request_status: 'ERROR', sub_request_error_reason: 'private-provider-details', campaign: existing }] },
    campaign({ ...existing, id: otherId }),
    campaign({ ...existing, status: 'PAUSED' }),
    { request_status: 'SUCCESS', campaigns: [] },
  ]) await assert.rejects(action('set-campaign-status').execute(credential, { accountId, campaignId, status: 'ACTIVE' }, {}), error => error instanceof ProviderError && !/private-provider|private-advertising/.test(error.message));
});

test('Snapchat invalid IDs, money and report times fail before network requests', async t => {
  const call = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not call'); });
  for (const accountId of ['../me', 'https://attacker.example', '12345']) await assert.rejects(action('list-campaigns').execute(credential, { accountId }, {}), ProviderError);
  for (const dailyBudget of ['0', '-1', '1e3', '1.1234567', '9999999999.999999']) await assert.rejects(action('create-campaign').execute(credential, { ...base, dailyBudget }, {}), ProviderError);
  for (const startTime of ['2026-02-30T00:00:00Z', '2026-10-01T00:00:00', '2012-12-30T00:00:00Z']) await assert.rejects(action('read-spend').execute(credential, { accountId, startTime, endTime: '2026-10-02T00:00:00Z' }, {}), ProviderError);
  assert.equal(call.mock.callCount(), 0);
});

test('Snapchat spend uses bounded real TOTAL reports with account currency and preserves missing metrics', async t => {
  let stats: Record<string, unknown> = { spend: 1_234_567, impressions: 123, swipes: 7 };
  const call = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = request(input, init);
    if (url.pathname === `/v1/adaccounts/${accountId}`) return Response.json(account());
    assert.equal(url.pathname, `/v1/adaccounts/${accountId}/stats`);
    assert.equal(url.searchParams.get('granularity'), 'TOTAL');
    assert.equal(url.searchParams.get('fields'), 'spend,impressions,swipes');
    assert.equal(url.searchParams.get('start_time'), '2026-09-30T23:00:00.000Z');
    assert.equal(url.searchParams.get('end_time'), '2026-10-01T23:00:00.000Z');
    assert.equal(url.searchParams.has('test'), false);
    assert.equal(url.searchParams.has('async'), false);
    return Response.json(envelope('total_stats', 'total_stat', { id: accountId, type: 'AD_ACCOUNT', granularity: 'TOTAL', stats }));
  });
  const values = { accountId, startTime: '2026-10-01T00:00:00+01:00', endTime: '2026-10-02T00:00:00+01:00' };
  const result = await action('read-spend').execute(credential, values, {});
  assert.deepEqual(result.items, [{ accountId, startTime: '2026-09-30T23:00:00.000Z', endTime: '2026-10-01T23:00:00.000Z', spend: '1.234567', spendMicros: '1234567', currency: 'GBP', timezone: 'Europe/London', impressions: '123', swipes: '7' }]);
  stats = {};
  assert.equal((await action('read-spend').execute(credential, values, {})).items?.[0].spend, null);
  assert.equal(call.mock.callCount(), 4);
});

test('Snapchat campaign reports verify account ownership before retrieving stats', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = request(input, init); calls.push(url.pathname);
    if (url.pathname === `/v1/adaccounts/${accountId}`) return Response.json(account());
    if (url.pathname === `/v1/campaigns/${campaignId}`) return Response.json(campaign());
    assert.equal(url.pathname, `/v1/campaigns/${campaignId}/stats`);
    return Response.json(envelope('total_stats', 'total_stat', { id: campaignId, type: 'CAMPAIGN', granularity: 'TOTAL', stats: { spend: 0 } }));
  });
  const result = await action('read-spend').execute(credential, { accountId, campaignId, startTime: '2026-10-01T00:00:00+01:00', endTime: '2026-10-02T00:00:00+01:00' }, {});
  assert.equal(result.items?.[0].spend, '0');
  assert.equal(calls.length, 3);
});

test('Snapchat TOTAL reports reject non-midnight UTC hours and unavailable account time zones before stats', async t => {
  let timezone: string | undefined = 'Europe/London';
  const calls = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = request(input, init);
    assert.equal(url.pathname, `/v1/adaccounts/${accountId}`, 'invalid boundaries must never fetch stats');
    return Response.json(envelope('adaccounts', 'adaccount', { id: accountId, currency: 'GBP', timezone }));
  });
  const values = { accountId, startTime: '2026-10-01T00:00:00Z', endTime: '2026-10-02T00:00:00Z' };
  await assert.rejects(action('read-spend').execute(credential, values, {}), /midnight.*Europe\/London/);
  timezone = undefined;
  await assert.rejects(action('read-spend').execute(credential, values, {}), /time zone/);
  timezone = 'invalid/private-token-timezone';
  await assert.rejects(action('read-spend').execute(credential, values, {}), error => error instanceof ProviderError && !error.message.includes('private-token'));
  assert.equal(calls.mock.callCount(), 3);
});

test('Snapchat TOTAL reports honor account-local days across DST and quarter-hour offsets', async t => {
  let timezone = 'Europe/London';
  const queries: URLSearchParams[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = request(input, init);
    if (url.pathname === `/v1/adaccounts/${accountId}`) return Response.json(envelope('adaccounts', 'adaccount', { id: accountId, currency: 'GBP', timezone }));
    assert.equal(url.pathname, `/v1/adaccounts/${accountId}/stats`);
    queries.push(url.searchParams);
    return Response.json(envelope('total_stats', 'total_stat', { id: accountId, type: 'AD_ACCOUNT', granularity: 'TOTAL', stats: { spend: 0 } }));
  });
  // 31 calendar days span 31 days + 1 hour during the autumn change.
  await action('read-spend').execute(credential, { accountId, startTime: '2026-10-01T00:00:00+01:00', endTime: '2026-11-01T00:00:00Z' }, {});
  assert.equal(queries[0].get('start_time'), '2026-09-30T23:00:00.000Z');
  assert.equal(queries[0].get('end_time'), '2026-11-01T00:00:00.000Z');
  timezone = 'Asia/Kathmandu';
  await action('read-spend').execute(credential, { accountId, startTime: '2026-10-01T00:00:00+05:45', endTime: '2026-10-02T00:00:00+05:45' }, {});
  assert.equal(queries[1].get('start_time'), '2026-09-30T18:15:00.000Z');
  assert.equal(queries[1].get('end_time'), '2026-10-01T18:15:00.000Z');
});
