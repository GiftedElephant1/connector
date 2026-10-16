import test from 'node:test';
import assert from 'node:assert/strict';
import { adsActions } from '../server/actions-ads';
import { ProviderError } from '../server/provider-types';

const credential = { accessToken: 'private-linkedin-ad-token' };
const env = { LINKEDIN_API_VERSION: '202601' };
const accountId = '558713659';
const values = { accountId, startDate: '2026-10-01', endDate: '2026-10-02' };

function action(id: string) {
  const result = adsActions.find(item => item.provider === 'linkedin-ads' && item.definition.id === id);
  assert.ok(result);
  return result;
}

// Rest.li parses structural delimiters before decoding primitive values. Looking
// only at URLSearchParams.get() would conceal the original over-encoding bug.
function rawParameters(url: URL): Map<string, string> {
  return new Map(url.search.slice(1).split('&').map(pair => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

function contractViolation(url: URL): string | undefined {
  const query = rawParameters(url);
  if (url.pathname.endsWith('/adCampaigns')) {
    if (query.get('q') !== 'search') return 'Unsupported finder';
    if (query.get('search') !== '(status:(values:List(ACTIVE,PAUSED,DRAFT)))') return 'Malformed Rest.li search';
    if (query.get('pageSize') !== '100' || query.has('count') || query.has('start')) return 'Unsupported pagination';
    return;
  }
  if (url.pathname === '/rest/adAnalytics') {
    if (query.get('q') !== 'analytics' || query.get('pivot') !== 'CAMPAIGN' || query.get('timeGranularity') !== 'DAILY') return 'Unsupported analytics finder';
    if (query.get('accounts') !== `List(urn%3Ali%3AsponsoredAccount%3A${accountId})`) return 'Malformed Rest.li account list';
    if (query.get('dateRange') !== '(start:(year:2026,month:10,day:1),end:(year:2026,month:10,day:2))') return 'Malformed Rest.li date range';
    if (query.get('fields') !== 'dateRange,pivotValues,costInLocalCurrency,impressions,clicks') return 'Malformed field projection';
    if (query.has('count') || query.has('start') || query.has('pageSize')) return 'Analytics pagination is unsupported';
    return;
  }
  return 'Unexpected resource';
}

function checkRequest(input: string | URL | Request, init: RequestInit | undefined) {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://api.linkedin.com');
  assert.equal(init?.method, 'GET');
  assert.equal(init?.body, undefined);
  assert.equal(init?.redirect, 'error');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${credential.accessToken}`);
  assert.equal(headers.get('LinkedIn-Version'), env.LINKEDIN_API_VERSION);
  assert.equal(headers.get('X-Restli-Protocol-Version'), '2.0.0');
  assert.equal(url.toString().includes(credential.accessToken), false);
  assert.equal(url.searchParams.has('access_token'), false);
  return url;
}

test('campaign reads use the account-scoped Rest.li search contract and cursor page size', async t => {
  const request = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = checkRequest(input, init);
    assert.equal(url.pathname, `/rest/adAccounts/${accountId}/adCampaigns`);
    const problem = contractViolation(url);
    if (problem) return Response.json({ status: 400, message: problem }, { status: 400 });
    return Response.json({ elements: [{ id: 987654321, name: 'Vectre Pay launch', status: 'DRAFT' }], metadata: {} });
  });
  const result = await action('list-campaigns').execute(credential, { accountId }, env);
  assert.deepEqual(result.items, [{ id: '987654321', name: 'Vectre Pay launch', status: 'DRAFT' }]);
  assert.equal(request.mock.callCount(), 1);
});

test('spend reads preserve Rest.li structure while encoding the account URN primitive once', async t => {
  const request = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = checkRequest(input, init);
    assert.equal(url.pathname, '/rest/adAnalytics');
    const problem = contractViolation(url);
    if (problem) return Response.json({ status: 400, message: problem }, { status: 400 });
    return Response.json({ elements: [{
      pivotValues: ['urn:li:sponsoredCampaign:987654321'],
      dateRange: { start: { year: 2026, month: 10, day: 1 }, end: { year: 2026, month: 10, day: 1 } },
      costInLocalCurrency: '123.45', impressions: 7890, clicks: 123,
    }] });
  });
  const result = await action('read-spend').execute(credential, values, env);
  assert.deepEqual(result.items, [{ campaign: 'urn:li:sponsoredCampaign:987654321', date: '2026-10-1', spend: '123.45', impressions: '7890', clicks: '123' }]);
  assert.equal(request.mock.callCount(), 1);
});

test('provider contract rejects the former encoded structures for both reads', () => {
  const campaign = new URL(`https://api.linkedin.com/rest/adAccounts/${accountId}/adCampaigns`);
  campaign.search = new URLSearchParams({ q: 'search', search: '(status:(values:List(ACTIVE,PAUSED,DRAFT)))', count: '100' }).toString();
  assert.equal(contractViolation(campaign), 'Malformed Rest.li search');
  const spend = new URL('https://api.linkedin.com/rest/adAnalytics');
  spend.search = new URLSearchParams({ q: 'analytics', pivot: 'CAMPAIGN', timeGranularity: 'DAILY', accounts: `List(urn:li:sponsoredAccount:${accountId})`, dateRange: '(start:(year:2026,month:10,day:1),end:(year:2026,month:10,day:2))', fields: 'dateRange,pivotValues,costInLocalCurrency,impressions,clicks' }).toString();
  assert.equal(contractViolation(spend), 'Malformed Rest.li account list');
});

test('empty campaign and reporting responses remain valid without inventing campaigns or spend', async t => {
  const request = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = checkRequest(input, init);
    const problem = contractViolation(url);
    if (problem) return Response.json({ status: 400, message: problem }, { status: 400 });
    return Response.json({ elements: [] });
  });
  for (const id of ['list-campaigns', 'read-spend']) {
    const result = await action(id).execute(credential, values, env);
    assert.deepEqual(result.items, []);
    assert.equal(JSON.stringify(result).includes(credential.accessToken), false);
  }
  assert.equal(request.mock.callCount(), 2);
});

test('invalid LinkedIn read account IDs and calendar ranges are rejected before making requests', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No request expected'); });
  for (const account of ['', '../558713659', '558713659?count=1000', 'urn:li:sponsoredAccount:558713659', '123456789012345678901']) {
    for (const id of ['list-campaigns', 'read-spend']) {
      await assert.rejects(action(id).execute(credential, { ...values, accountId: account }, env), ProviderError);
    }
  }
  for (const dates of [
    { startDate: '2026-02-30', endDate: '2026-03-01' },
    { startDate: '2026-10-02', endDate: '2026-10-01' },
    { startDate: '2026-10-01', endDate: '2026-11-01' },
    { startDate: '2026-10-01)&accounts=List(999)', endDate: '2026-10-02' },
  ]) {
    await assert.rejects(action('read-spend').execute(credential, { ...values, ...dates }, env), ProviderError);
  }
  assert.equal(request.mock.callCount(), 0);
});
