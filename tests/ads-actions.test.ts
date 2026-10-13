import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { adsActions } from '../server/actions-ads';
import type { ActionValues } from '../server/action-types';
import { ProviderError } from '../server/provider-types';

const action = (provider: string, id: string) => adsActions.find(item => item.provider === provider && item.definition.id === id)!;
const credential = { accessToken: 'access', fields: { consumerKey: 'consumer', consumerSecret: 'consumer-secret', accessTokenSecret: 'token-secret' } };
const env = { MICROSOFT_ADS_DEVELOPER_TOKEN: 'developer', REDDIT_CONVERSIONS_TOKEN: 'events-secret', LINKEDIN_ENABLE_CONVERSIONS: 'true' };
const values: ActionValues = {
  accountId: '123', customerId: '456', campaignId: '789', campaignGroupId: '234', name: 'Summer campaign', dailyBudget: '50.25', costPerClick: '2.5', currency: 'USD',
  targetingCriteria: '{"include":{"and":[{"or":{"urn:li:adTargetingFacet:locations":["urn:li:geo:103644278"]}}]}}',
  fundingInstrumentId: 'fund1', timeZone: 'Taipei', startTime: '2026-10-14T01:00:00Z',
  startDate: '2026-10-01', endDate: '2026-10-02', reportTimeZone: 'Taipei', status: 'ACTIVE',
};

test('every advertising provider exposes reads and explicitly classified writes', () => {
  for (const provider of ['linkedin-ads', 'microsoft-ads', 'tiktok-business', 'x-ads', 'reddit-ads']) {
    assert.equal(action(provider, 'list-campaigns').definition.kind, 'read');
    for (const id of ['create-campaign', 'set-campaign-status', 'send-conversion']) {
      assert.equal(action(provider, id).definition.kind, 'write');
      assert.equal(action(provider, id).definition.schedulable, undefined);
    }
  }
  assert.equal(new Set(adsActions.map(item => `${item.provider}:${item.definition.id}`)).size, adsActions.length);
});

test('all five campaign creators force paused/disabled state and honor account budgets', async (t) => {
  let provider = '';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, 'POST');
    if (provider === 'x-ads') {
      assert.equal(url, 'https://ads-api.x.com/12/accounts/123/campaigns');
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('entity_status'), 'PAUSED');
      assert.equal(body.get('daily_budget_amount_local_micro'), '50250000');
      assert.equal(body.get('funding_instrument_id'), 'fund1');
      return Response.json({ data: { id: 'x1' } });
    }
    const body = JSON.parse(String(init.body));
    if (provider === 'linkedin-ads') {
      assert.equal(url, 'https://api.linkedin.com/rest/adAccounts/123/adCampaigns');
      assert.equal(body.status, 'PAUSED');
      assert.deepEqual(body.dailyBudget, { amount: '50.25', currencyCode: 'USD' });
      assert.equal(body.campaignGroup, 'urn:li:sponsoredCampaignGroup:234');
      return Response.json({}, { status: 201, headers: { 'x-restli-id': 'li1' } });
    }
    if (provider === 'microsoft-ads') {
      assert.equal(url, 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns');
      assert.equal(body.Campaigns[0].Status, 'Paused');
      assert.equal(body.Campaigns[0].DailyBudget, 50.25);
      assert.equal(body.Campaigns[0].BudgetType, 'DailyBudgetStandard');
      assert.equal(new Headers(init.headers).get('CustomerAccountId'), '123');
      return Response.json({ CampaignIds: ['ms1'], PartialErrors: [] });
    }
    if (provider === 'tiktok-business') {
      assert.equal(url, 'https://business-api.tiktok.com/open_api/v1.3/campaign/create/');
      assert.equal(body.operation_status, 'DISABLE');
      assert.equal(body.budget_mode, 'BUDGET_MODE_DAY');
      assert.equal(body.budget, 50.25);
      return Response.json({ code: 0, data: { campaign_id: 'tt1' } });
    }
    assert.equal(url, 'https://ads-api.reddit.com/api/v3/ad_accounts/123/campaigns');
    assert.equal(body.data.configured_status, 'PAUSED');
    assert.equal(body.data.goal_value, 50250000);
    return Response.json({ data: { id: 'rd1' } });
  });
  for (provider of ['linkedin-ads', 'microsoft-ads', 'tiktok-business', 'x-ads', 'reddit-ads']) {
    const result = await action(provider, 'create-campaign').execute(credential, values, env);
    assert.match(String(result.items![0].status), /^(PAUSED|Paused|DISABLE)$/);
  }
});

test('campaign status writes use platform-specific update methods and payloads', async (t) => {
  let provider = '';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (provider === 'x-ads') {
      assert.equal(init.method, 'PUT');
      assert.equal(new URLSearchParams(String(init.body)).get('entity_status'), 'ACTIVE');
      return Response.json({ data: { id: '789' } });
    }
    const body = JSON.parse(String(init.body));
    if (provider === 'linkedin-ads') {
      assert.equal(init.method, 'POST');
      assert.match(url, /adAccounts\/123\/adCampaigns\/789$/);
      assert.equal(new Headers(init.headers).get('X-RestLi-Method'), 'PARTIAL_UPDATE');
      assert.deepEqual(body, { patch: { $set: { status: 'ACTIVE' } } });
      return new Response(null, { status: 204 });
    }
    if (provider === 'microsoft-ads') {
      assert.equal(init.method, 'PUT');
      assert.deepEqual(body.Campaigns, [{ Id: '789', Status: 'Active' }]);
      return Response.json({ PartialErrors: [] });
    }
    if (provider === 'tiktok-business') {
      assert.match(url, /campaign\/status\/update\/$/);
      assert.deepEqual(body.campaign_ids, ['789']);
      assert.equal(body.operation_status, 'ENABLE');
      return Response.json({ code: 0, data: {} });
    }
    assert.equal(init.method, 'PATCH');
    assert.equal(body.data.configured_status, 'ACTIVE');
    return Response.json({ data: { id: '789' } });
  });
  for (provider of ['linkedin-ads', 'microsoft-ads', 'tiktok-business', 'x-ads', 'reddit-ads']) await action(provider, 'set-campaign-status').execute(credential, values, env);
});

test('X OAuth1 signatures include the HTTP method and complete form body', async (t) => {
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const header = new Headers(init.headers).get('authorization')!;
    const oauth = Object.fromEntries(header.slice(6).split(', ').map(pair => {
      const [key, value] = pair.split('=');
      return [key, decodeURIComponent(value.slice(1, -1))];
    }));
    const signature = oauth.oauth_signature;
    delete oauth.oauth_signature;
    const pairs = [...Object.entries(oauth), ...new URLSearchParams(String(init.body))].map(([k, v]) => [encode(k), encode(v)]).sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
    const base = `${init.method}&${encode(url)}&${encode(pairs.map(([k, v]) => `${k}=${v}`).join('&'))}`;
    assert.equal(signature, createHmac('sha1', 'consumer-secret&token-secret').update(base).digest('base64'));
    return Response.json({ data: { id: 'x1' } });
  });
  await action('x-ads', 'create-campaign').execute(credential, { ...values, name: 'A + B & C!' }, env);
});

test('Microsoft HTTP200 partial failures never report success or leak provider messages', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ CampaignIds: [null], PartialErrors: [{ Index: 0, Message: 'private-user-token' }] }));
  await assert.rejects(action('microsoft-ads', 'create-campaign').execute(credential, values, env), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /partially failed/);
    assert.equal(error.message.includes('private-user-token'), false);
    return true;
  });
});

test('TikTok HTTP200 business errors never report accepted writes', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 40002, message: 'private-token', data: {} }));
  await assert.rejects(action('tiktok-business', 'set-campaign-status').execute(credential, values, env), /rejected or did not confirm/);
});

test('Microsoft spend report requests dates/currency and never downloads provider URLs', async (t) => {
  let count = 0;
  const request = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    count++;
    const body = JSON.parse(String(init.body));
    if (count === 1) {
      assert.equal(url, 'https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/Submit');
      assert.equal(body.ReportRequest.Type, 'CampaignPerformanceReportRequest');
      assert.equal(body.ReportRequest.Aggregation, 'Summary');
      assert.ok(body.ReportRequest.Columns.includes('CurrencyCode'));
      assert.deepEqual(body.ReportRequest.Time.CustomDateRangeEnd, { Year: 2026, Month: 10, Day: 2 });
      return Response.json({ ReportRequestId: 'report1' });
    }
    assert.equal(url, 'https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/Poll');
    return Response.json({ ReportRequestStatus: { Status: 'Success', ReportDownloadUrl: 'https://reports.blob.core.windows.net/official-report.zip' } });
  });
  const started = await action('microsoft-ads', 'request-spend-report').execute(credential, values, env);
  assert.equal(started.items![0].reportId, 'report1');
  const done = await action('microsoft-ads', 'read-spend-report').execute(credential, { ...values, reportId: 'report1' }, env);
  assert.equal(done.link, 'https://reports.blob.core.windows.net/official-report.zip');
  assert.equal(request.mock.callCount(), 2);
});

test('Microsoft pending and unsafe report links are handled explicitly', async (t) => {
  let pending = true;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ReportRequestStatus: pending ? { Status: 'Pending' } : { Status: 'Success', ReportDownloadUrl: 'javascript:alert(1)' } }));
  assert.match((await action('microsoft-ads', 'read-spend-report').execute(credential, { ...values, reportId: 'r1' }, env)).summary, /still being generated/);
  pending = false;
  await assert.rejects(action('microsoft-ads', 'read-spend-report').execute(credential, { ...values, reportId: 'r1' }, env), /invalid report link/);
});

test('TikTok spend uses advertiser reporting dimensions and outputs primitive rows', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const query = new URL(url).searchParams;
    assert.deepEqual(JSON.parse(query.get('dimensions')!), ['campaign_id', 'stat_time_day']);
    assert.equal(query.get('data_level'), 'AUCTION_CAMPAIGN');
    assert.equal(query.get('end_date'), '2026-10-02');
    return Response.json({ code: 0, data: { list: [{ dimensions: { campaign_id: '789', stat_time_day: '2026-10-01' }, metrics: { spend: '12.30', clicks: '20', impressions: '200' } }] } });
  });
  const result = await action('tiktok-business', 'read-spend').execute(credential, values, env);
  assert.equal(result.items![0].spend, '12.30');
});

test('Reddit report parses data.metrics and uses lowercase report breakdowns', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://ads-api.reddit.com/api/v3/ad_accounts/123/reports');
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.data.breakdowns, ['campaign_id', 'date']);
    assert.equal(body.data.ends_at, '2026-10-03T00:00:00.000Z');
    return Response.json({ data: { metrics: [{ campaign_id: '789', date: '2026-10-01', spend: 12000000, clicks: 20, impressions: 200 }] } });
  });
  const result = await action('reddit-ads', 'read-spend').execute(credential, values, env);
  assert.equal(result.items![0].campaign, '789');
  assert.equal(result.items![0].spend, '12000000');
});

test('X spend converts billing micros and limits synchronous date ranges', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async (url: string) => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('placement'), 'ALL_ON_TWITTER');
    assert.equal(query.get('metric_groups'), 'BILLING,ENGAGEMENT');
    assert.equal(query.get('granularity'), 'TOTAL');
    return Response.json({ data: [{ id: '789', id_data: [{ metrics: { billed_charge_local_micro: [2500000], impressions: [20], engagements: [2] } }] }] });
  });
  const result = await action('x-ads', 'read-spend').execute(credential, { ...values, campaignIds: '789' }, env);
  assert.equal(result.items![0].spend, 2.5);
  await assert.rejects(action('x-ads', 'read-spend').execute(credential, { ...values, campaignIds: '789', endDate: '2026-10-20' }, env), /seven-day/);
  assert.equal(request.mock.callCount(), 1);
});

const conversionValues = (): ActionValues => ({ ...values, eventTime: new Date(Date.now() - 60_000).toISOString(), value: '12.3', conversionName: 'Purchase', conversionId: 'order-123', clickId: 'original-click', pixelId: 'pixel123', eventName: 'CompletePayment', eventId: 'event-123', emailHash: 'a'.repeat(64) });

test('Microsoft offline conversion schema uses original click ID, goal name, UTC time and currency', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/OfflineConversions/Apply');
    const event = JSON.parse(String(init.body)).OfflineConversions[0];
    assert.equal(event.MicrosoftClickId, 'original-click');
    assert.equal(event.ConversionName, 'Purchase');
    assert.equal(event.ConversionValue, 12.3);
    assert.equal(event.ConversionCurrencyCode, 'USD');
    assert.ok(event.ConversionTime.endsWith('Z'));
    return Response.json({ PartialErrors: [] });
  });
  await action('microsoft-ads', 'send-conversion').execute(credential, conversionValues(), env);
});

test('LinkedIn CAPI requires approved scope, hashed email and exact conversion URN', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.linkedin.com/rest/conversionEvents');
    const event = JSON.parse(String(init.body));
    assert.equal(event.conversion, 'urn:lla:llaPartnerConversion:555');
    assert.equal(event.user.userIds[0].idType, 'SHA256_EMAIL');
    assert.equal(event.conversionValue.amount, '12.3');
    assert.equal(typeof event.conversionHappenedAt, 'number');
    return new Response(null, { status: 201 });
  });
  await assert.rejects(action('linkedin-ads', 'send-conversion').execute(credential, conversionValues(), {}), /rw_conversions/);
  await assert.rejects(action('linkedin-ads', 'send-conversion').execute(credential, { ...conversionValues(), conversionId: '555', emailHash: 'person@example.test' }, env), /SHA-256/);
  await action('linkedin-ads', 'send-conversion').execute(credential, { ...conversionValues(), conversionId: '555' }, env);
  assert.equal(request.mock.callCount(), 1);
});

test('TikTok conversion supports its dedicated Events token without putting it in the body', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://business-api.tiktok.com/open_api/v1.3/pixel/track/');
    assert.equal(new Headers(init.headers).get('Access-Token'), 'pixel-secret');
    const event = JSON.parse(String(init.body));
    assert.equal(event.context.ad.callback, 'original-click');
    assert.equal(event.pixel_code, 'pixel123');
    assert.equal(event.properties.value, 12.3);
    assert.equal(String(init.body).includes('pixel-secret'), false);
    return Response.json({ code: 0, data: {} });
  });
  await action('tiktok-business', 'send-conversion').execute(credential, conversionValues(), { ...env, TIKTOK_EVENTS_ACCESS_TOKEN: 'pixel-secret' });
});

test('Reddit CAPI uses separate token, millisecond event time and hashed deduplication ID', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://ads-api.reddit.com/api/v3/pixels/pixel123/conversion_events');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer events-secret');
    const body = JSON.parse(String(init.body));
    assert.equal(body.data.partner, undefined);
    const event = body.data.events[0];
    assert.equal(event.type.tracking_type, 'PURCHASE');
    assert.equal(event.action_source, 'WEBSITE');
    assert.equal(event.metadata.conversion_id, createHash('sha256').update('order-123').digest('hex'));
    assert.ok(event.event_at > 1_000_000_000_000);
    return Response.json({ data: {} });
  });
  await assert.rejects(action('reddit-ads', 'send-conversion').execute(credential, conversionValues(), {}), /REDDIT_CONVERSIONS_TOKEN/);
  await action('reddit-ads', 'send-conversion').execute(credential, conversionValues(), env);
  assert.equal(request.mock.callCount(), 1);
});

test('X conversions reject per-event errors even under HTTP200', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://ads-api.x.com/12/measurement/conversions/pixel123');
    const event = JSON.parse(String(init.body)).conversions[0];
    assert.deepEqual(event.identifiers, [{ twclid: 'original-click' }]);
    assert.equal(event.price_currency, 'USD');
    assert.equal(event.currency, undefined);
    return Response.json({ data: [{ errors: [{ code: 'BAD_EVENT', message: 'private-value' }] }] });
  });
  await assert.rejects(action('x-ads', 'send-conversion').execute(credential, conversionValues(), env), /partially failed/);
});

test('X conversion success requires the processed event count', async (t) => {
  let processed = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { conversions_processed: processed, debug_id: 'not-exposed' } }));
  await assert.rejects(action('x-ads', 'send-conversion').execute(credential, conversionValues(), env), /did not confirm/);
  processed = 1;
  const result = await action('x-ads', 'send-conversion').execute(credential, conversionValues(), env);
  assert.match(result.summary, /accepted/);
  assert.equal(JSON.stringify(result).includes('not-exposed'), false);
});

test('unsafe IDs, malformed calendar dates and invalid status fail before network', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  for (const provider of ['linkedin-ads', 'microsoft-ads', 'tiktok-business', 'x-ads', 'reddit-ads']) {
    await assert.rejects(action(provider, 'set-campaign-status').execute(credential, { ...values, accountId: '../admin' }, env), ProviderError);
    await assert.rejects(action(provider, 'set-campaign-status').execute(credential, { ...values, status: 'DELETE' }, env), /ACTIVE or PAUSED/);
  }
  await assert.rejects(action('tiktok-business', 'read-spend').execute(credential, { ...values, startDate: '2026-02-30' }, env), /calendar dates/);
  assert.equal(request.mock.callCount(), 0);
});
