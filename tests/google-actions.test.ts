import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { googleActions } from '../server/actions-google';
import { ProviderError } from '../server/provider-types';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'private-access-token' };
const env = { GOOGLE_ADS_DEVELOPER_TOKEN: 'private-developer-token' };
const account = { customerId: '123-456-7890', loginCustomerId: '987-654-3210' };
const range = { startDate: '2026-10-01', endDate: '2026-10-13' };
const action = (provider: string, id: string) => {
  const adapter = googleActions.find((item) => item.provider === provider && item.definition.id === id);
  assert.ok(adapter);
  return adapter;
};
const json = (init?: RequestInit): Record<string, any> => JSON.parse(String(init?.body));

function mock(body: unknown, inspect: (url: string, init?: RequestInit) => void = () => {}) {
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credential.accessToken}`);
    inspect(String(input), init);
    return Response.json(body);
  };
}

test('YouTube sends multipart video bytes and metadata to the official upload origin', async () => {
  const bytes = Buffer.from('small-video-test-fixture');
  mock({ id: 'video123', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } }, (url, init) => {
    assert.equal(url, 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status&notifySubscribers=false');
    assert.equal(init?.method, 'POST');
    const contentType = new Headers(init?.headers).get('content-type')!;
    assert.match(contentType, /^multipart\/related; boundary=connector_/);
    const boundary = contentType.split('boundary=')[1];
    const body = Buffer.from(init?.body as Uint8Array).toString();
    assert.ok(body.startsWith(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`));
    const metadata = JSON.parse(body.split('\r\n\r\n')[1].split(`\r\n--${boundary}`)[0]);
    assert.deepEqual(metadata, { snippet: { title: 'My video', description: 'Description', categoryId: '22' }, status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } });
    assert.ok(body.includes('Content-Type: video/mp4\r\n\r\nsmall-video-test-fixture'));
    assert.ok(body.endsWith(`\r\n--${boundary}--\r\n`));
  });
  const result = await action('youtube', 'publish-video').execute(credential, { title: 'My video', description: 'Description', media: `data:video/mp4;base64,${bytes.toString('base64')}`, madeForKids: 'false' }, {});
  assert.match(result.summary, /accepted.*private/);
  assert.equal(result.link, 'https://www.youtube.com/watch?v=video123');
  assert.equal(action('youtube', 'publish-video').definition.schedulable, true);
});

test('YouTube reports returned visibility when an unaudited project upload is forced private', async () => {
  mock({ id: 'abc', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } });
  const result = await action('youtube', 'publish-video').execute(credential, { title: 'Video', privacy: 'public', madeForKids: 'true', media: 'data:video/mp4;base64,YWJj' }, {});
  assert.equal(result.items?.[0].visibility, 'private');
  mock({ id: 'abc', status: { uploadStatus: 'rejected' } });
  await assert.rejects(action('youtube', 'publish-video').execute(credential, { title: 'Video', madeForKids: 'true', media: 'data:video/mp4;base64,YWJj' }, {}), /rejected or failed/);
});

test('YouTube rejects remote media URLs, malformed base64 and oversized videos without fetching', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  for (const media of ['https://internal.example/video.mp4', 'data:text/plain;base64,YWJj', 'data:video/mp4;base64,***', `data:video/mp4;base64,${'A'.repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4 + 101)}`]) {
    await assert.rejects(action('youtube', 'publish-video').execute(credential, { title: 'Video', madeForKids: 'false', media }, {}), ProviderError);
  }
  assert.equal(called, false);
});

test('YouTube comment read exposes replyable comment IDs without private upstream fields', async () => {
  mock({ items: [{ snippet: { topLevelComment: { id: 'comment123', snippet: { authorDisplayName: 'Viewer', textOriginal: 'Nice video', publishedAt: '2026-10-13T00:00:00Z', privateValue: credential.accessToken } }, totalReplyCount: 2 } }] }, (url, init) => {
    const request = new URL(url);
    assert.equal(request.origin + request.pathname, 'https://youtube.googleapis.com/youtube/v3/commentThreads');
    assert.equal(request.searchParams.get('videoId'), 'video123');
    assert.equal(request.searchParams.get('textFormat'), 'plainText');
    assert.equal(init?.method, 'GET');
  });
  const result = await action('youtube', 'list-comments').execute(credential, { videoId: 'video123' }, {});
  assert.equal(result.items?.[0].commentId, 'comment123');
  assert.equal(JSON.stringify(result).includes(credential.accessToken), false);
});

test('YouTube replies through comments.insert using the parent comment and original text', async () => {
  mock({ id: 'reply123' }, (url, init) => {
    assert.equal(url, 'https://youtube.googleapis.com/youtube/v3/comments?part=snippet');
    assert.deepEqual(json(init), { snippet: { parentId: 'comment123', textOriginal: 'Thank you!' } });
  });
  const result = await action('youtube', 'reply-comment').execute(credential, { commentId: 'comment123', text: 'Thank you!' }, {});
  assert.equal(result.items?.[0].commentId, 'reply123');
});

test('YouTube channel report uses daily watch and view metrics with a bounded response', async () => {
  mock({ rows: [['2026-10-01', 123, 456]] }, (url) => {
    const request = new URL(url);
    assert.equal(request.origin + request.pathname, 'https://youtubeanalytics.googleapis.com/v2/reports');
    assert.equal(request.searchParams.get('ids'), 'channel==MINE');
    assert.equal(request.searchParams.get('metrics'), 'views,estimatedMinutesWatched');
    assert.equal(request.searchParams.get('dimensions'), 'day');
    assert.equal(request.searchParams.get('maxResults'), '100');
  });
  assert.deepEqual((await action('youtube', 'channel-analytics').execute(credential, range, {})).items, [{ date: '2026-10-01', views: '123', estimatedMinutesWatched: '456' }]);
});

test('Google Ads creates a paused campaign and budget atomically with exact money precision', async () => {
  mock({ mutateOperationResponses: [{ campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/11' } }, { campaignResult: { resourceName: 'customers/1234567890/campaigns/22' } }] }, (url, init) => {
    assert.equal(url, 'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:mutate');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('developer-token'), env.GOOGLE_ADS_DEVELOPER_TOKEN);
    assert.equal(headers.get('login-customer-id'), '9876543210');
    const body = json(init);
    assert.equal(body.partialFailure, false);
    assert.equal(body.mutateOperations.length, 2);
    const budget = body.mutateOperations[0].campaignBudgetOperation.create;
    const campaign = body.mutateOperations[1].campaignOperation.create;
    assert.equal(budget.resourceName, 'customers/1234567890/campaignBudgets/-1');
    assert.equal(budget.amountMicros, '12345678');
    assert.equal(budget.period, 'DAILY');
    assert.equal(budget.explicitlyShared, false);
    assert.equal(campaign.campaignBudget, budget.resourceName);
    assert.equal(campaign.status, 'PAUSED');
    assert.equal(campaign.advertisingChannelType, 'SEARCH');
    assert.equal(campaign.containsEuPoliticalAdvertising, 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING');
    assert.deepEqual(campaign.manualCpc, {});
  });
  const result = await action('google-ads', 'create-search-campaign').execute(credential, { ...account, name: 'Search test', dailyBudget: '12.345678', euPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING' }, env);
  assert.equal(result.items?.[0].status, 'PAUSED');
  assert.equal(result.items?.[0].campaign, 'customers/1234567890/campaigns/22');
});

test('Google Ads campaign status mutation changes only status with explicit enable selection', async () => {
  mock({ results: [{ resourceName: 'customers/1234567890/campaigns/22' }] }, (url, init) => {
    assert.equal(url, 'https://googleads.googleapis.com/v25/customers/1234567890/campaigns:mutate');
    assert.deepEqual(json(init), { partialFailure: false, operations: [{ update: { resourceName: 'customers/1234567890/campaigns/22', status: 'ENABLED' }, updateMask: 'status' }] });
  });
  const result = await action('google-ads', 'set-campaign-status').execute(credential, { ...account, campaignId: '22', status: 'ENABLED' }, env);
  assert.match(result.summary, /deliver and spend/);
});

test('Google Ads list and spend use GAQL with no unsupported pageSize', async () => {
  mock({ results: [{ campaign: { id: '22', name: 'Search', status: 'PAUSED' } }] }, (_url, init) => {
    assert.equal(json(init).pageSize, undefined);
    assert.match(json(init).query, /LIMIT 100$/);
  });
  assert.equal((await action('google-ads', 'list-campaigns').execute(credential, account, env)).items?.[0].status, 'PAUSED');
  mock({ results: [{ segments: { date: '2026-10-01' }, campaign: { id: '22', name: 'Search' }, metrics: { costMicros: '1234567', impressions: '20', clicks: '3', conversions: 1 }, customer: { currencyCode: 'USD' } }] }, (_url, init) => {
    assert.match(json(init).query, /segments.date BETWEEN '2026-10-01' AND '2026-10-13'/);
    assert.match(json(init).query, /customer.currency_code/);
  });
  const result = await action('google-ads', 'campaign-spend').execute(credential, { ...account, ...range }, env);
  assert.equal(result.items?.[0].spend, '1.234567');
  assert.equal(result.items?.[0].currency, 'USD');
  assert.match(result.summary, /not a complete account total/);
});

const conversion = { ...account, gclid: 'test-gclid', conversionAction: '42', conversionDateTime: '2026-10-13 12:00:00+08:00', value: '12.50', currency: 'usd', adUserDataConsent: 'GRANTED', orderId: 'order-123' };

test('Google Ads click upload declares supported consent and mandatory partial failure mode', async () => {
  mock({ results: [{ conversionAction: 'customers/1234567890/conversionActions/42', conversionDateTime: conversion.conversionDateTime, gclid: conversion.gclid }] }, (url, init) => {
    assert.equal(url, 'https://googleads.googleapis.com/v25/customers/1234567890:uploadClickConversions');
    const body = json(init);
    assert.equal(body.partialFailure, true);
    assert.deepEqual(body.conversions, [{ gclid: conversion.gclid, conversionAction: 'customers/1234567890/conversionActions/42', conversionDateTime: conversion.conversionDateTime, conversionValue: 12.5, currencyCode: 'USD', consent: { adUserData: 'GRANTED' }, orderId: 'order-123' }]);
    assert.equal(Object.hasOwn(body.conversions[0].consent, 'adPersonalization'), false);
  });
  const result = await action('google-ads', 'upload-conversion').execute(credential, conversion, env);
  assert.match(result.summary, /accepted/);
  assert.equal(JSON.stringify(result).includes(conversion.gclid), false);
});

test('Google Ads HTTP200 partial failures and error arrays never report a successful write', async () => {
  for (const response of [
    { partialFailureError: { code: 3, message: credential.accessToken }, results: [{}] },
    { error: { message: credential.accessToken } },
    { errors: [{ message: credential.accessToken }] },
  ]) {
    mock(response);
    await assert.rejects(action('google-ads', 'upload-conversion').execute(credential, conversion, env), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /failed or partially failed/);
      assert.equal(error.message.includes(credential.accessToken), false);
      return true;
    });
  }
  mock({ results: [{}] });
  await assert.rejects(action('google-ads', 'upload-conversion').execute(credential, conversion, env), /did not confirm/);
});

test('Google Ads validates IDs, money, date ranges and consent before sending writes', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  await assert.rejects(action('google-ads', 'set-campaign-status').execute(credential, { ...account, campaignId: '../99', status: 'ENABLED' }, env), /digits/);
  await assert.rejects(action('google-ads', 'create-search-campaign').execute(credential, { ...account, name: 'Name', dailyBudget: '0', euPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING' }, env), /greater than zero/);
  await assert.rejects(action('google-ads', 'upload-conversion').execute(credential, { ...conversion, adUserDataConsent: 'unknown' }, env), /Choose a valid/);
  await assert.rejects(action('google-ads', 'upload-conversion').execute(credential, { ...conversion, conversionDateTime: '2026-02-31 12:00:00+08:00' }, env), /valid calendar/);
  await assert.rejects(action('google-ads', 'campaign-spend').execute(credential, { ...account, startDate: "2026-10-01' OR 1=1", endDate: '2026-10-13' }, env), /valid calendar/);
  await assert.rejects(action('google-ads', 'campaign-spend').execute(credential, { ...account, startDate: '2026-10-13', endDate: '2026-10-01' }, env), /ordered date range/);
  assert.equal(calls, 0);
});

test('GA4 traffic report uses the Data API with ordered date, traffic metrics and a 100-row limit', async () => {
  mock({ rows: [{ dimensionValues: [{ value: '20261001' }], metricValues: [{ value: '12' }, { value: '23' }, { value: '45' }] }] }, (url, init) => {
    assert.equal(url, 'https://analyticsdata.googleapis.com/v1beta/properties/456:runReport');
    assert.deepEqual(json(init), { dateRanges: [range], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: '100' });
  });
  const result = await action('google-analytics', 'traffic-report').execute(credential, { ...range, propertyId: 'properties/456' }, {});
  assert.deepEqual(result.items, [{ date: '20261001', activeUsers: '12', sessions: '23', views: '45' }]);
});

test('Search Console URL properties are encoded as API path values and never fetched', async () => {
  mock({ rows: [{ keys: ['2026-10-01'], clicks: 12, impressions: 100, ctr: 0.12, position: 4 }] }, (url, init) => {
    assert.equal(url, 'https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query');
    assert.deepEqual(json(init), { ...range, dimensions: ['date'], type: 'web', rowLimit: 100, dataState: 'final' });
  });
  assert.equal((await action('search-console', 'search-performance').execute(credential, { ...range, siteUrl: 'https://example.com/' }, {})).items?.[0].clicks, '12');
});

test('empty analytics are shown as empty rows and upstream authorization failures stay redacted', async () => {
  mock({});
  assert.deepEqual((await action('google-analytics', 'traffic-report').execute(credential, { ...range, propertyId: '456' }, {})).items, []);
  globalThis.fetch = async () => Response.json({ error: credential.accessToken }, { status: 403 });
  await assert.rejects(action('youtube', 'reply-comment').execute(credential, { commentId: '123', text: 'Reply' }, {}), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /denied this action/);
    assert.equal(error.message.includes(credential.accessToken), false);
    return true;
  });
});
