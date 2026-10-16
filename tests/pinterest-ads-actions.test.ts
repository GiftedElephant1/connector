import test from 'node:test';
import assert from 'node:assert/strict';
import { pinterestAdsActions } from '../server/actions-pinterest-ads';
import { ProviderError } from '../server/provider-types';

const credential = { accessToken: 'private-pinterest-ads-token' };
const accountId = '549755885175', campaignId = '549755885176';
const budget = { accountId, campaignId, name: 'Vectre Pay launch', dailyBudget: '12.34', currency: 'GBP' };
const report = { accountId, startDate: '2026-10-01', endDate: '2026-10-02' };
const account = { id: accountId, currency: 'GBP' };
const campaign = { id: campaignId, ad_account_id: accountId, name: budget.name, status: 'PAUSED', objective_type: 'CONSIDERATION', daily_spend_cap: 12_340_000, is_campaign_budget_optimization: true, lifetime_spend_cap: null };
const batch = (data: Record<string, unknown>) => ({ items: [{ data, exceptions: [] }] });
function action(id: string) {
  const adapter = pinterestAdsActions.find(value => value.definition.id === id);
  assert.ok(adapter);
  return adapter;
}
function checkRequest(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://api.pinterest.com');
  assert.equal(init?.redirect, 'error');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${credential.accessToken}`);
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(url.toString().includes(credential.accessToken), false);
  assert.equal(url.searchParams.has('access_token'), false);
  if (init?.body !== undefined) assert.equal(headers.get('content-type'), 'application/json');
  return url;
}

test('Pinterest Ads separates read actions from spending writes and never schedules them', () => {
  assert.deepEqual(pinterestAdsActions.map(({ provider, definition: { id, kind } }) => ({ provider, id, kind })), [
    { provider: 'pinterest-ads', id: 'list-campaigns', kind: 'read' },
    { provider: 'pinterest-ads', id: 'create-campaign', kind: 'write' },
    { provider: 'pinterest-ads', id: 'set-campaign-status', kind: 'write' },
    { provider: 'pinterest-ads', id: 'set-campaign-budget', kind: 'write' },
    { provider: 'pinterest-ads', id: 'read-spend', kind: 'read' },
  ]);
  for (const { definition } of pinterestAdsActions) assert.equal(definition.schedulable, undefined);
  assert.match(action('set-campaign-status').definition.description, /start spending/);
  assert.match(action('set-campaign-budget').definition.description, /spend more immediately/);
});

test('Pinterest lists only the chosen account first page without fetching provider bookmarks', async t => {
  const request = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = checkRequest(input, init);
    assert.equal(url.pathname, `/v5/ad_accounts/${accountId}/campaigns`);
    assert.equal(url.search, '?page_size=100');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    return Response.json({ items: [campaign], bookmark: 'https://attacker.invalid/?access_token=private' });
  });
  const result = await action('list-campaigns').execute(credential, { accountId }, {});
  assert.deepEqual(result.items, [{ id: campaignId, accountId, name: budget.name, status: 'PAUSED', objective: 'CONSIDERATION', dailyBudgetMicros: '12340000', lifetimeBudgetMicros: null }]);
  assert.match(result.summary, /More campaigns/);
  assert.equal(request.mock.callCount(), 1);
  assert.equal(JSON.stringify(result).includes('attacker'), false);
});

test('Pinterest creates exactly one paused daily-budget campaign using official batch contract and precise microunits', async t => {
  const request = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = checkRequest(input, init);
    if (url.pathname === `/v5/ad_accounts/${accountId}`) { assert.equal(init?.method, 'GET'); return Response.json(account); }
    assert.equal(url.pathname, `/v5/ad_accounts/${accountId}/campaigns`);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), [{ ad_account_id: accountId, name: budget.name, objective_type: 'CONSIDERATION', status: 'PAUSED', daily_spend_cap: 12_340_001, is_campaign_budget_optimization: true, is_flexible_daily_budgets: false, is_performance_plus: false }]);
    return Response.json(batch({ ...campaign, daily_spend_cap: 12_340_001 }));
  });
  const result = await action('create-campaign').execute(credential, { ...budget, dailyBudget: '12.340001', status: 'ACTIVE' }, {});
  assert.deepEqual(result.items, [{ id: campaignId, accountId, status: 'PAUSED', dailyBudget: '12.340001', dailyBudgetMicros: '12340001', currency: 'GBP' }]);
  assert.equal(request.mock.callCount(), 2);
});

test('Pinterest activation and pause update only the explicit campaign status with PATCH array', async t => {
  const request = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = checkRequest(input, init);
    assert.equal(url.pathname, `/v5/ad_accounts/${accountId}/campaigns`);
    assert.equal(init?.method, 'PATCH');
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(payload[0]).sort(), ['ad_account_id', 'id', 'status']);
    assert.equal(payload[0].ad_account_id, accountId);
    assert.equal(payload[0].id, campaignId);
    return Response.json(batch({ ...campaign, status: payload[0].status }));
  });
  for (const status of ['ACTIVE', 'PAUSED']) {
    const result = await action('set-campaign-status').execute(credential, { accountId, campaignId, status }, {});
    assert.deepEqual(result.items, [{ id: campaignId, accountId, status }]);
  }
  assert.equal(request.mock.callCount(), 2);
});

test('Pinterest daily budget update verifies account and campaign then preserves status and budget mode', async t => {
  const request = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = checkRequest(input, init);
    if (init?.method === 'GET') {
      if (url.pathname === `/v5/ad_accounts/${accountId}`) return Response.json(account);
      assert.equal(url.pathname, `/v5/ad_accounts/${accountId}/campaigns/${campaignId}`);
      return Response.json({ ...campaign, status: 'ACTIVE' });
    }
    assert.equal(url.pathname, `/v5/ad_accounts/${accountId}/campaigns`);
    assert.equal(init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(init?.body)), [{ ad_account_id: accountId, id: campaignId, daily_spend_cap: 25_300_000 }]);
    return Response.json(batch({ ...campaign, status: 'ACTIVE', daily_spend_cap: 25_300_000 }));
  });
  const result = await action('set-campaign-budget').execute(credential, { ...budget, dailyBudget: '25.30' }, {});
  assert.deepEqual(result.items, [{ id: campaignId, accountId, dailyBudget: '25.3', dailyBudgetMicros: '25300000', currency: 'GBP' }]);
  assert.equal(request.mock.callCount(), 3);
});

test('Pinterest refuses currency mismatch before sending a campaign write', async t => {
  const request = t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    assert.equal(init?.method, 'GET');
    return Response.json({ id: accountId, currency: 'USD' });
  });
  for (const id of ['create-campaign', 'set-campaign-budget']) await assert.rejects(action(id).execute(credential, budget, {}), /must match.*USD/);
  assert.equal(request.mock.callCount(), 2);
});

test('Pinterest refuses to switch lifetime or ad-group budgets to daily budgets', async t => {
  for (const existing of [
    { ...campaign, is_campaign_budget_optimization: false },
    { ...campaign, is_campaign_budget_optimization: undefined },
    { ...campaign, lifetime_spend_cap: 50_000_000 },
    { ...campaign, daily_spend_cap: null },
    { ...campaign, daily_spend_cap: 0 },
  ]) {
    const request = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, 'GET');
      return Response.json(String(input).endsWith(`/campaigns/${campaignId}`) ? existing : account);
    });
    await assert.rejects(action('set-campaign-budget').execute(credential, budget, {}), /existing daily campaign budgets only/);
    assert.equal(request.mock.callCount(), 2);
    request.mock.restore();
  }
});

test('Pinterest daily account spend returns account-currency amounts and distinguishes missing metrics from zero', async t => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = checkRequest(input, init);
    assert.equal(init?.method, 'GET');
    if (url.pathname === `/v5/ad_accounts/${accountId}`) return Response.json(account);
    assert.equal(url.pathname, `/v5/ad_accounts/${accountId}/analytics`);
    assert.deepEqual(Object.fromEntries(url.searchParams), { start_date: report.startDate, end_date: report.endDate, granularity: 'DAY', columns: 'AD_ACCOUNT_ID,SPEND_IN_MICRO_DOLLAR,PAID_IMPRESSION,OUTBOUND_CLICK_1' });
    return Response.json([
      { AD_ACCOUNT_ID: accountId, DATE: report.startDate, SPEND_IN_MICRO_DOLLAR: 12_340_001, PAID_IMPRESSION: 100, OUTBOUND_CLICK_1: 0 },
      { AD_ACCOUNT_ID: accountId, DATE: report.endDate },
    ]);
  });
  const result = await action('read-spend').execute(credential, report, {});
  assert.deepEqual(result.items, [
    { accountId, date: report.startDate, spend: '12.340001', spendMicros: '12340001', currency: 'GBP', impressions: '100', outboundClicks: '0' },
    { accountId, date: report.endDate, spend: null, spendMicros: null, currency: 'GBP', impressions: null, outboundClicks: null },
  ]);
  assert.match(result.summary, /MICRO_DOLLAR.*account currency/);
  assert.match(result.summary, /do not establish zero spend/);
});

test('Pinterest campaign reporting uses selected campaign IDs and marks clipped previews', async t => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = checkRequest(input, init);
    if (url.pathname === `/v5/ad_accounts/${accountId}`) return Response.json(account);
    assert.equal(url.pathname, `/v5/ad_accounts/${accountId}/campaigns/analytics`);
    assert.deepEqual(url.searchParams.getAll('campaign_ids'), [campaignId, '12345']);
    assert.match(url.search, new RegExp(`campaign_ids=${campaignId}&campaign_ids=12345$`));
    assert.equal(url.searchParams.get('columns'), 'CAMPAIGN_ID,SPEND_IN_MICRO_DOLLAR,PAID_IMPRESSION,OUTBOUND_CLICK_1');
    return Response.json(Array.from({ length: 101 }, () => ({ CAMPAIGN_ID: campaignId, DATE: report.startDate, SPEND_IN_MICRO_DOLLAR: 0 })));
  });
  const result = await action('read-spend').execute(credential, { ...report, campaignIds: `${campaignId},12345,${campaignId}` }, {});
  assert.equal(result.items?.length, 100);
  assert.equal(result.items?.[0]?.spend, '0');
  assert.match(result.summary, /not a complete range total/);
});

test('Pinterest accepts empty lists without inventing campaigns or zero spend', async t => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    return Response.json(path.endsWith('/campaigns') ? { items: [] } : path.endsWith('/analytics') ? [] : account);
  });
  for (const id of ['list-campaigns', 'read-spend']) assert.deepEqual((await action(id).execute(credential, report, {})).items, []);
});

test('Pinterest validates numeric IDs, budgets, statuses and dates before making requests', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No request expected'); });
  for (const accountId of ['', '../123', '123?ad_account_id=456', '1234567890123456789', 'https://attacker.invalid']) {
    for (const { definition } of pinterestAdsActions) await assert.rejects(action(definition.id).execute(credential, { ...budget, ...report, status: 'PAUSED', accountId }, {}), ProviderError);
  }
  for (const campaignId of ['', 'abc', '../123', '1/2']) {
    for (const id of ['set-campaign-status', 'set-campaign-budget']) await assert.rejects(action(id).execute(credential, { ...budget, campaignId, status: 'PAUSED' }, {}), ProviderError);
  }
  for (const dailyBudget of ['0', '-1', '1e3', '12,34', '0.0000001', '9007199254.740992']) {
    for (const id of ['create-campaign', 'set-campaign-budget']) await assert.rejects(action(id).execute(credential, { ...budget, dailyBudget }, {}), ProviderError);
  }
  for (const status of ['ENABLED', 'DELETED', 'active']) await assert.rejects(action('set-campaign-status').execute(credential, { ...budget, status }, {}), ProviderError);
  for (const dates of [
    { startDate: '2026-02-30', endDate: '2026-03-02' },
    { startDate: '2026-10-03', endDate: '2026-10-01' },
    { startDate: '2026-10-01', endDate: '2026-11-01' },
  ]) await assert.rejects(action('read-spend').execute(credential, { accountId, ...dates }, {}), ProviderError);
  for (const campaignIds of ['123,,456', '../../123', Array.from({ length: 21 }, (_, i) => String(i)).join(',')]) await assert.rejects(action('read-spend').execute(credential, { ...report, campaignIds }, {}), ProviderError);
  await assert.rejects(action('create-campaign').execute(credential, { ...budget, name: 'A'.repeat(256) }, {}), ProviderError);
  assert.equal(request.mock.callCount(), 0);
});

test('Pinterest batch errors and missing or mismatched confirmation never report success', async t => {
  const responses = [
    {}, { items: [] }, { items: [null] }, { items: [{ data: campaign, exceptions: [{ code: 2, message: credential.accessToken }] }] },
    { items: [{ data: campaign, errors: ['secret-in-provider-message'] }] },
    { items: [{ data: {} }] }, batch({ ...campaign, id: '999' }), batch({ ...campaign, ad_account_id: '999' }),
    batch({ ...campaign, status: 'ACTIVE' }), { items: [{ data: campaign }, { data: campaign }] },
    { error: credential.accessToken, items: [{ data: campaign }] },
  ];
  for (const response of responses) {
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json(response));
    await assert.rejects(action('set-campaign-status').execute(credential, { accountId, campaignId, status: 'PAUSED' }, {}), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(credential.accessToken), false);
      assert.equal(error.message.includes('secret-in-provider-message'), false);
      return true;
    });
    assert.equal(request.mock.callCount(), 1);
    request.mock.restore();
  }
});

test('Pinterest budget and create writes require returned requested values', async t => {
  for (const result of [batch({ ...campaign, daily_spend_cap: 999 }), batch({ ...campaign, status: 'ACTIVE' }), batch({ id: campaignId })]) {
    const request = t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => Response.json(init?.method === 'GET' ? account : result));
    await assert.rejects(action('create-campaign').execute(credential, budget, {}), /did not confirm/);
    assert.equal(request.mock.callCount(), 2);
    request.mock.restore();
  }
});

test('Pinterest rejects wrong report identities, invalid dates and unsafe numeric spend', async t => {
  for (const row of [
    { AD_ACCOUNT_ID: '999', DATE: report.startDate },
    { AD_ACCOUNT_ID: accountId, DATE: '2026-09-30' },
    { AD_ACCOUNT_ID: accountId, DATE: '2026-02-30' },
    { AD_ACCOUNT_ID: accountId, DATE: report.startDate, SPEND_IN_MICRO_DOLLAR: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const request = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => Response.json(String(input).includes('/analytics?') ? [row] : account));
    await assert.rejects(action('read-spend').execute(credential, report, {}), ProviderError);
    assert.equal(request.mock.callCount(), 2);
    request.mock.restore();
  }
});

test('Pinterest HTTP, redirect and network failures are not retried or leaked', async t => {
  for (const status of [400, 401, 403, 429, 500]) {
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ message: credential.accessToken }, { status }));
    await assert.rejects(action('set-campaign-status').execute(credential, { accountId, campaignId, status: 'ACTIVE' }, {}), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(credential.accessToken), false);
      return true;
    });
    assert.equal(request.mock.callCount(), 1);
    request.mock.restore();
  }
  const request = t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => { assert.equal(init?.redirect, 'error'); throw new Error(`Redirect to https://attacker.invalid/${credential.accessToken}`); });
  await assert.rejects(action('set-campaign-status').execute(credential, { accountId, campaignId, status: 'PAUSED' }, {}), error => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /check the platform before retrying/i);
    assert.equal(error.message.includes(credential.accessToken), false);
    return true;
  });
  assert.equal(request.mock.callCount(), 1);
});
