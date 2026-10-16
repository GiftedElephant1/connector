import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { apiJson, apiRequest, bearer, numeric, required, string } from './action-http';
import type { ActionAdapter, ActionField, ActionValues } from './action-types';
import { isObject, safeCredential } from './provider-http';
import { ProviderError, type Credential } from './provider-types';
import { xAuthorization } from './providers-ads';
import { linkedInAdsHttpOptions } from './linkedin-ads-errors';

export const adsActions: ActionAdapter[] = [];
const field = (name: string, label: string, type: ActionField['type'] = 'text', help?: string): ActionField => ({ name, label, type, required: true, ...(help ? { help } : {}) });
const account = field('accountId', 'Advertising account ID');
const campaign = field('campaignId', 'Campaign ID');
const title = field('name', 'Campaign name');
const budget = field('dailyBudget', 'Daily budget', 'number', 'In the advertising account currency; platform minimums apply.');
const currency = field('currency', 'Currency (ISO 4217)', 'text', 'For example USD, TWD, EUR. Must match the account or conversion configuration.');
const dateFields = [field('startDate', 'Start date (YYYY-MM-DD)'), field('endDate', 'End date (YYYY-MM-DD)', 'text', 'Inclusive; at most 31 calendar days. Provider reporting timezone applies.')];
const eventFields = [field('eventTime', 'Conversion time with timezone', 'datetime'), field('value', 'Conversion value', 'number'), currency];
const stateField: ActionField = { name: 'status', label: 'Campaign status', type: 'select', required: true, options: [{ value: 'ACTIVE', label: 'Launch / enable (may start spending)' }, { value: 'PAUSED', label: 'Pause' }] };

function add(provider: string, id: string, label: string, kind: 'read' | 'write', fields: ActionField[], description: string, execute: ActionAdapter['execute']) {
  adsActions.push({ provider, definition: { id, label, kind, fields, group: 'advertising', description }, execute });
}
function key(values: ActionValues, name: string): string {
  const value = required(values, name);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new ProviderError(`${name} must be an identifier without URL separators.`);
  return value;
}
function numericId(values: ActionValues, name: string): string {
  const value = key(values, name);
  if (!/^\d{1,20}$/.test(value)) throw new ProviderError(`${name} must be a numeric ID.`);
  return value;
}
function status(values: ActionValues): string {
  const value = required(values, 'status');
  if (!['ACTIVE', 'PAUSED'].includes(value)) throw new ProviderError('Choose ACTIVE or PAUSED.');
  return value;
}
function isoCurrency(values: ActionValues): string {
  const value = required(values, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) throw new ProviderError('Currency must be a three-letter ISO 4217 code.');
  return value;
}
function timestamp(values: ActionValues, name: string): string {
  const value = required(values, name);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ProviderError(`${name} must be a date-time with a timezone.`);
  return new Date(value).toISOString();
}
function dates(values: ActionValues) {
  const start = required(values, 'startDate'), end = required(values, 'endDate');
  for (const date of [start, end]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new ProviderError('Use valid YYYY-MM-DD calendar dates.');
  }
  if (end < start || Date.parse(end) - Date.parse(start) >= 31 * 86400000) throw new ProviderError('Use an ordered range of at most 31 days.');
  return { start, end, exclusiveEnd: new Date(Date.parse(end) + 86400000).toISOString() };
}
function entries(value: unknown, provider: string) {
  if (!Array.isArray(value) || !value.every(isObject)) throw new ProviderError(`${provider} returned an unexpected list.`, 502);
  return value.slice(0, 100);
}
function check(body: Record<string, unknown>, provider: string) {
  for (const key of ['errors', 'Errors', 'PartialErrors', 'BatchErrors', 'OperationErrors']) {
    const errors = body[key];
    if ((Array.isArray(errors) && errors.length) || (isObject(errors) && Object.keys(errors).length) || (typeof errors === 'string' && errors)) throw new ProviderError(`${provider} reported a failed or partially failed operation. Check the platform before retrying.`, 502);
  }
  if (body.error || body.error_code || (typeof body.Type === 'string' && body.Type.endsWith('FaultDetail'))) throw new ProviderError(`${provider} rejected this operation. Check permissions and the platform before retrying.`, 502);
  return body;
}
function confirmedId(value: unknown, provider: string) {
  const result = string(value);
  if (!result) throw new ProviderError(`${provider} did not confirm an identifier. Check the platform before retrying.`, 502);
  return result;
}
function jsonObject(values: ActionValues, name: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(required(values, name)); } catch { throw new ProviderError(`${name} must be a JSON object.`); }
  if (!isObject(parsed)) throw new ProviderError(`${name} must be a JSON object.`);
  return parsed;
}
function sha256(values: ActionValues, name: string): string {
  const value = required(values, name).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new ProviderError(`${name} must be a SHA-256 hex hash; never submit plaintext contact information here.`);
  return value;
}
function envValue(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value || /[\r\n]/.test(value)) throw new ProviderError(`Configure ${name} on the server first.`, 503);
  return value;
}
function micros(values: ActionValues): number {
  const amount = numeric(values, 'dailyBudget', 0.01) * 1_000_000;
  if (!Number.isSafeInteger(amount)) throw new ProviderError('Daily budget must resolve to a safe integer number of micro-currency units.');
  return amount;
}

// LinkedIn Marketing APIs. Ad group, targeting, creative, and billing eligibility remain platform requirements.
function liHeaders(credential: Credential, env: NodeJS.ProcessEnv) {
  const version = env.LINKEDIN_API_VERSION?.trim() || '202601';
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(version)) throw new ProviderError('Configure a supported LINKEDIN_API_VERSION in YYYYMM format.');
  return { ...bearer(credential), 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' };
}
async function liRequest(credential: Credential, env: NodeJS.ProcessEnv, path: string, method = 'GET', body?: unknown, partial = false) {
  const result = await apiRequest('LinkedIn Ads', `https://api.linkedin.com/rest/${path}`, {
    method, headers: { ...liHeaders(credential, env), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(partial ? { 'X-RestLi-Method': 'PARTIAL_UPDATE' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, linkedInAdsHttpOptions);
  if (!isObject(result.body)) throw new ProviderError('LinkedIn Ads returned an unexpected response.', 502);
  check(result.body, 'LinkedIn Ads');
  return { ...result, body: result.body };
}
const liCampaignPath = (v: ActionValues) => `adAccounts/${numericId(v, 'accountId')}/adCampaigns`;
add('linkedin-ads', 'list-campaigns', 'List campaigns', 'read', [account], 'Read the first 100 campaigns in an approved LinkedIn ad account.', async (c, v, env) => {
  // Rest.li 2.0 requires literal structural delimiters; URLSearchParams encodes them.
  // Account-scoped campaign search uses cursor pagination (pageSize), not count.
  const query = 'q=search&search=(status:(values:List(ACTIVE,PAUSED,DRAFT)))&pageSize=100';
  const { body } = await liRequest(c, env, `${liCampaignPath(v)}?${query}`);
  return { summary: 'LinkedIn campaigns (first page).', items: entries(body.elements, 'LinkedIn Ads').map(row => ({ id: string(row.id), name: string(row.name), status: string(row.status) })) };
});
add('linkedin-ads', 'create-campaign', 'Create paused campaign', 'write', [account, title, field('campaignGroupId', 'Existing campaign group ID'), budget, currency, field('costPerClick', 'Maximum cost per click', 'number'), field('targetingCriteria', 'LinkedIn targeting criteria JSON', 'textarea', 'Use the approved Marketing API targetingCriteria schema, including a valid geo target.')], 'Create a paused sponsored-content website-visits campaign in an existing group. Delivery also requires valid targeting, approved creatives, active parents, and billing.', async (c, v, env) => {
  const { body, headers } = await liRequest(c, env, liCampaignPath(v), 'POST', {
    account: `urn:li:sponsoredAccount:${numericId(v, 'accountId')}`, campaignGroup: `urn:li:sponsoredCampaignGroup:${numericId(v, 'campaignGroupId')}`,
    name: required(v, 'name'), status: 'PAUSED', type: 'SPONSORED_UPDATES', objectiveType: 'WEBSITE_VISITS', costType: 'CPC',
    dailyBudget: { amount: String(numeric(v, 'dailyBudget', 0.01)), currencyCode: isoCurrency(v) },
    unitCost: { amount: String(numeric(v, 'costPerClick', 0.01)), currencyCode: isoCurrency(v) },
    locale: { language: 'en', country: 'US' }, targetingCriteria: jsonObject(v, 'targetingCriteria'),
  });
  const id = confirmedId(headers.get('x-restli-id') || body.id, 'LinkedIn Ads');
  return { summary: 'Paused LinkedIn campaign created. Add approved creatives before launching.', items: [{ id, status: 'PAUSED' }] };
});
add('linkedin-ads', 'set-campaign-status', 'Launch or pause campaign', 'write', [account, campaign, stateField], 'Enabling an existing configured campaign can start ad spend. This does not create its targeting, creatives, or billing setup.', async (c, v, env) => {
  await liRequest(c, env, `${liCampaignPath(v)}/${numericId(v, 'campaignId')}`, 'POST', { patch: { $set: { status: status(v) } } }, true);
  return { summary: 'LinkedIn accepted the campaign status change.', items: [{ id: v.campaignId, status: status(v) }] };
});
add('linkedin-ads', 'read-spend', 'Read campaign spend', 'read', [account, ...dateFields], 'Read a daily campaign spend preview in local account currency. Requires r_ads_reporting; first 100 returned rows.', async (c, v, env) => {
  const range = dates(v);
  const dateTuple = (date: string) => { const [year, month, day] = date.split('-').map(Number); return `(year:${year},month:${month},day:${day})`; };
  // Encode the URN value inside List(...), preserving the list/record syntax.
  // Dates are validated above and each component is an integer, not arbitrary input.
  const accountUrn = encodeURIComponent(`urn:li:sponsoredAccount:${numericId(v, 'accountId')}`);
  const query = `q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY&accounts=List(${accountUrn})&dateRange=(start:${dateTuple(range.start)},end:${dateTuple(range.end)})&fields=dateRange,pivotValues,costInLocalCurrency,impressions,clicks`;
  const { body } = await liRequest(c, env, `adAnalytics?${query}`);
  return { summary: 'LinkedIn campaign spend in account currency (first 100 rows).', items: entries(body.elements, 'LinkedIn Ads').map(row => ({ campaign: Array.isArray(row.pivotValues) ? string(row.pivotValues[0]) : '', date: isObject(row.dateRange) && isObject(row.dateRange.start) ? `${string(row.dateRange.start.year)}-${string(row.dateRange.start.month)}-${string(row.dateRange.start.day)}` : '', spend: string(row.costInLocalCurrency), impressions: string(row.impressions), clicks: string(row.clicks) })) };
});
add('linkedin-ads', 'send-conversion', 'Send conversion event', 'write', [field('conversionId', 'Existing LinkedIn conversion rule ID'), field('eventId', 'Stable event ID (deduplication)'), field('emailHash', 'Normalized email SHA-256 hash'), ...eventFields], 'Upload one conversion for an approved conversion rule. Requires approved rw_conversions access and LINKEDIN_ENABLE_CONVERSIONS=true, then reconnect.', async (c, v, env) => {
  if (env.LINKEDIN_ENABLE_CONVERSIONS !== 'true') throw new ProviderError('Enable LINKEDIN_ENABLE_CONVERSIONS after LinkedIn approves rw_conversions, then reconnect.', 403);
  await liRequest(c, env, 'conversionEvents', 'POST', {
    conversion: `urn:lla:llaPartnerConversion:${numericId(v, 'conversionId')}`, conversionHappenedAt: Date.parse(timestamp(v, 'eventTime')), eventId: required(v, 'eventId'),
    conversionValue: { currencyCode: isoCurrency(v), amount: String(numeric(v, 'value')) }, user: { userIds: [{ idType: 'SHA256_EMAIL', idValue: sha256(v, 'emailHash') }] },
  });
  return { summary: 'LinkedIn accepted the conversion event. Attribution and matching remain asynchronous.' };
});

// Microsoft Advertising REST (v13). PartialErrors must be checked even on HTTP 200.
const msFields = [account, field('customerId', 'Managing customer ID')];
function msHeaders(c: Credential, v: ActionValues, env: NodeJS.ProcessEnv) {
  return { ...bearer(c), 'content-type': 'application/json', DeveloperToken: envValue(env, 'MICROSOFT_ADS_DEVELOPER_TOKEN'), CustomerAccountId: numericId(v, 'accountId'), CustomerId: numericId(v, 'customerId') };
}
async function msRequest(c: Credential, v: ActionValues, env: NodeJS.ProcessEnv, path: string, body: unknown, method = 'POST', reporting = false) {
  return check(await apiJson('Microsoft Advertising', `https://${reporting ? 'reporting' : 'campaign'}.api.bingads.microsoft.com/${reporting ? 'Reporting' : 'CampaignManagement'}/v13/${path}`, { method, headers: msHeaders(c, v, env), body: JSON.stringify(body) }), 'Microsoft Advertising');
}
add('microsoft-ads', 'list-campaigns', 'List Search campaigns', 'read', msFields, 'Read Search campaigns for the selected Microsoft Advertising account.', async (c, v, env) => {
  const body = await msRequest(c, v, env, 'Campaigns/QueryByAccountId', { AccountId: numericId(v, 'accountId'), CampaignType: 'Search' });
  return { summary: 'Microsoft Search campaigns (up to 100).', items: entries(body.Campaigns ?? [], 'Microsoft Advertising').map(row => ({ id: string(row.Id), name: string(row.Name), status: string(row.Status), dailyBudget: string(row.DailyBudget) })) };
});
add('microsoft-ads', 'create-campaign', 'Create paused Search campaign', 'write', [...msFields, title, budget, field('timeZone', 'Microsoft campaign timezone', 'text', 'Use the Microsoft timezone enum, for example Taipei or PacificTimeUSCanadaTijuana.')], 'Create a paused Search campaign. Ad groups, keywords, approved ads, and billing must be configured before delivery.', async (c, v, env) => {
  const body = await msRequest(c, v, env, 'Campaigns', { AccountId: numericId(v, 'accountId'), Campaigns: [{ Name: required(v, 'name'), CampaignType: 'Search', Status: 'Paused', BudgetType: 'DailyBudgetStandard', DailyBudget: numeric(v, 'dailyBudget', 0.01), TimeZone: key(v, 'timeZone'), Languages: ['All'] }] });
  const id = confirmedId(Array.isArray(body.CampaignIds) ? body.CampaignIds[0] : undefined, 'Microsoft Advertising');
  return { summary: 'Paused Microsoft Search campaign created.', items: [{ id, status: 'Paused' }] };
});
add('microsoft-ads', 'set-campaign-status', 'Launch or pause campaign', 'write', [...msFields, campaign, stateField], 'Change a configured campaign status. Enabling it can start ad spend when its ads and billing are eligible.', async (c, v, env) => {
  const value = status(v) === 'ACTIVE' ? 'Active' : 'Paused';
  await msRequest(c, v, env, 'Campaigns', { AccountId: numericId(v, 'accountId'), Campaigns: [{ Id: numericId(v, 'campaignId'), Status: value }] }, 'PUT');
  return { summary: 'Microsoft accepted the campaign status change.', items: [{ id: v.campaignId, status: value }] };
});
add('microsoft-ads', 'request-spend-report', 'Request campaign spend report', 'read', [...msFields, ...dateFields, field('reportTimeZone', 'Microsoft report timezone', 'text', 'For example Taipei or PacificTimeUSCanadaTijuana.')], 'Request an asynchronous CSV spend report in each account currency. Use the returned report ID with Read spend report.', async (c, v, env) => {
  const range = dates(v);
  const reportDate = (date: string) => { const [Year, Month, Day] = date.split('-').map(Number); return { Year, Month, Day }; };
  const body = await msRequest(c, v, env, 'GenerateReport/Submit', { ReportRequest: {
    Type: 'CampaignPerformanceReportRequest', Format: 'Csv', FormatVersion: '2.0', Aggregation: 'Summary', ExcludeColumnHeaders: false, ExcludeReportHeader: true, ExcludeReportFooter: true, ReturnOnlyCompleteData: false,
    Columns: ['AccountId', 'CampaignId', 'CampaignName', 'CurrencyCode', 'Spend', 'Impressions', 'Clicks'], Scope: { AccountIds: [numericId(v, 'accountId')] },
    Time: { CustomDateRangeStart: reportDate(range.start), CustomDateRangeEnd: reportDate(range.end), ReportTimeZone: key(v, 'reportTimeZone') },
  } }, 'POST', true);
  return { summary: 'Microsoft is generating the spend report. Poll using this report ID.', items: [{ reportId: confirmedId(body.ReportRequestId, 'Microsoft Advertising') }] };
});
add('microsoft-ads', 'read-spend-report', 'Read spend report status', 'read', [...msFields, field('reportId', 'Report request ID')], 'Poll a previously requested report. A completed report has a temporary official ZIP/CSV download link, usually valid for five minutes.', async (c, v, env) => {
  const body = await msRequest(c, v, env, 'GenerateReport/Poll', { ReportRequestId: key(v, 'reportId') }, 'POST', true);
  if (!isObject(body.ReportRequestStatus)) throw new ProviderError('Microsoft returned an unexpected report status.', 502);
  const state = string(body.ReportRequestStatus.Status);
  if (state === 'Error') throw new ProviderError('Microsoft could not generate the report. Check the account and request a new report.', 502);
  if (state === 'Pending') return { summary: 'The report is still being generated. Poll this report ID again later.', items: [{ status: state }] };
  if (state !== 'Success') throw new ProviderError('Microsoft returned an unknown report status.', 502);
  const download = string(body.ReportRequestStatus.ReportDownloadUrl);
  if (!download) return { summary: 'Report completed with no data for the requested range.', items: [] };
  let url: URL;
  try { url = new URL(download); } catch { throw new ProviderError('Microsoft returned an invalid report link.', 502); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /(?:^|\.)(localhost|local|internal|test|example|invalid)$/.test(url.hostname)) throw new ProviderError('Microsoft returned an invalid report link.', 502);
  return { summary: 'Spend report is ready. Download the official ZIP/CSV report; the link expires shortly.', link: url.toString(), items: [{ status: state, format: 'ZIP containing CSV', expires: 'Approximately five minutes' }] };
});
add('microsoft-ads', 'send-conversion', 'Send offline conversion', 'write', [...msFields, field('conversionName', 'Existing OfflineConversionGoal name'), field('clickId', 'Microsoft click ID (msclkid)'), ...eventFields], 'Upload one conversion to an existing offline conversion goal. Use the original click ID and actual UTC event time; provider attribution windows apply.', async (c, v, env) => {
  await msRequest(c, v, env, 'OfflineConversions/Apply', { OfflineConversions: [{ MicrosoftClickId: required(v, 'clickId'), ConversionName: required(v, 'conversionName'), ConversionTime: timestamp(v, 'eventTime'), ConversionValue: numeric(v, 'value'), ConversionCurrencyCode: isoCurrency(v) }] });
  return { summary: 'Microsoft accepted the offline conversion upload without partial errors. Attribution is processed asynchronously.' };
});

// TikTok for Business: code=0 is required even when HTTP status is 200.
async function ttRequest(c: Credential, path: string, body?: unknown, token?: string) {
  const response = await apiJson('TikTok Business', `https://business-api.tiktok.com/open_api/v1.3/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Access-Token': token || safeCredential(c), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.code !== 0 || !isObject(response.data)) throw new ProviderError('TikTok Business rejected or did not confirm this operation. Check permissions and the platform before retrying.', 502);
  return check(response.data, 'TikTok Business');
}
add('tiktok-business', 'list-campaigns', 'List campaigns', 'read', [account], 'Read up to 100 campaigns for a TikTok advertiser ID (not a Business Center ID).', async (c, v) => {
  const body = await ttRequest(c, `campaign/get/?${new URLSearchParams({ advertiser_id: numericId(v, 'accountId'), page: '1', page_size: '100' })}`);
  return { summary: 'TikTok campaigns (first page).', items: entries(body.list, 'TikTok Business').map(row => ({ id: string(row.campaign_id), name: string(row.campaign_name), status: string(row.operation_status), budget: string(row.budget) })) };
});
add('tiktok-business', 'create-campaign', 'Create paused traffic campaign', 'write', [account, title, budget], 'Create a disabled TikTok traffic campaign with a daily budget. Ad groups, placements, targeting, approved ads, and billing are still required.', async (c, v) => {
  const body = await ttRequest(c, 'campaign/create/', { advertiser_id: numericId(v, 'accountId'), campaign_name: required(v, 'name'), objective_type: 'TRAFFIC', budget_mode: 'BUDGET_MODE_DAY', budget: numeric(v, 'dailyBudget', 0.01), operation_status: 'DISABLE' });
  return { summary: 'Disabled TikTok traffic campaign created.', items: [{ id: confirmedId(body.campaign_id, 'TikTok Business'), status: 'DISABLE' }] };
});
add('tiktok-business', 'set-campaign-status', 'Launch or pause campaign', 'write', [account, campaign, stateField], 'Enable or disable a configured campaign. Enabling can begin ad spend when child entities and billing are eligible.', async (c, v) => {
  const operation = status(v) === 'ACTIVE' ? 'ENABLE' : 'DISABLE';
  await ttRequest(c, 'campaign/status/update/', { advertiser_id: numericId(v, 'accountId'), campaign_ids: [numericId(v, 'campaignId')], operation_status: operation });
  return { summary: 'TikTok accepted the campaign status change.', items: [{ id: v.campaignId, status: operation }] };
});
add('tiktok-business', 'read-spend', 'Read campaign spend', 'read', [account, ...dateFields], 'Read daily auction-campaign spend in advertiser currency, up to 100 report rows.', async (c, v) => {
  const range = dates(v);
  const query = new URLSearchParams({ advertiser_id: numericId(v, 'accountId'), report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', dimensions: JSON.stringify(['campaign_id', 'stat_time_day']), metrics: JSON.stringify(['spend', 'impressions', 'clicks']), start_date: range.start, end_date: range.end, page: '1', page_size: '100' });
  const body = await ttRequest(c, `report/integrated/get/?${query}`);
  return { summary: 'TikTok campaign spend in account currency (first 100 rows).', items: entries(body.list, 'TikTok Business').map(row => {
    if (!isObject(row.dimensions) || !isObject(row.metrics)) throw new ProviderError('TikTok returned an unexpected report row.', 502);
    return { campaign: string(row.dimensions.campaign_id), date: string(row.dimensions.stat_time_day), spend: string(row.metrics.spend), impressions: string(row.metrics.impressions), clicks: string(row.metrics.clicks) };
  }) };
});
add('tiktok-business', 'send-conversion', 'Send pixel conversion', 'write', [field('pixelId', 'TikTok pixel code'), field('eventName', 'Standard TikTok event name'), field('eventId', 'Stable event ID for deduplication'), field('clickId', 'Original TikTok click ID (ttclid)'), ...eventFields], 'Send one web event through the official pixel/track API. Requires access to this pixel; optionally configure TIKTOK_EVENTS_ACCESS_TOKEN for its Events API token.', async (c, v, env) => {
  const token = env.TIKTOK_EVENTS_ACCESS_TOKEN ? envValue(env, 'TIKTOK_EVENTS_ACCESS_TOKEN') : undefined;
  await ttRequest(c, 'pixel/track/', { pixel_code: key(v, 'pixelId'), event: key(v, 'eventName'), event_id: required(v, 'eventId'), timestamp: timestamp(v, 'eventTime'), context: { ad: { callback: required(v, 'clickId') } }, properties: { value: numeric(v, 'value'), currency: isoCurrency(v) } }, token);
  return { summary: 'TikTok accepted the pixel event. Matching and attribution are processed asynchronously.' };
});

// X Ads API uses OAuth 1.0a. Form bodies participate in signing; JSON does not.
function xBase(env: NodeJS.ProcessEnv) {
  const version = env.X_ADS_API_VERSION || '12';
  if (!/^\d{1,3}$/.test(version)) throw new ProviderError('Configure a numeric X_ADS_API_VERSION.');
  return `https://ads-api.x.com/${version}`;
}
async function xRequest(c: Credential, env: NodeJS.ProcessEnv, path: string, method = 'GET', form?: Record<string, string>, json?: unknown) {
  const url = `${xBase(env)}/${path}`;
  const body = form ? new URLSearchParams(form) : undefined;
  return check(await apiJson('X Ads', url, { method, headers: { authorization: xAuthorization(url, c, method, body), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : json ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : json ? { body: JSON.stringify(json) } : {}) }), 'X Ads');
}
const xCampaignPath = (v: ActionValues) => `accounts/${key(v, 'accountId')}/campaigns`;
add('x-ads', 'list-campaigns', 'List campaigns', 'read', [account], 'Read the first 100 X advertising campaigns.', async (c, v, env) => {
  const body = await xRequest(c, env, `${xCampaignPath(v)}?count=100`);
  return { summary: 'X campaigns (first page).', items: entries(body.data, 'X Ads').map(row => ({ id: string(row.id), name: string(row.name), status: string(row.entity_status), currency: string(row.currency) })) };
});
add('x-ads', 'create-campaign', 'Create paused campaign', 'write', [account, title, budget, field('fundingInstrumentId', 'Existing funding instrument ID')], 'Create a paused X campaign using an existing funding instrument. Line items, targeting, promoted content, and eligible funding are still required.', async (c, v, env) => {
  const body = await xRequest(c, env, xCampaignPath(v), 'POST', { name: required(v, 'name'), funding_instrument_id: key(v, 'fundingInstrumentId'), daily_budget_amount_local_micro: String(micros(v)), entity_status: 'PAUSED' });
  return { summary: 'Paused X campaign created.', items: [{ id: confirmedId(isObject(body.data) ? body.data.id : undefined, 'X Ads'), status: 'PAUSED' }] };
});
add('x-ads', 'set-campaign-status', 'Launch or pause campaign', 'write', [account, campaign, stateField], 'Enable or pause a configured X campaign. Enabling may start spending through eligible line items and promoted content.', async (c, v, env) => {
  const body = await xRequest(c, env, `${xCampaignPath(v)}/${key(v, 'campaignId')}`, 'PUT', { entity_status: status(v) });
  confirmedId(isObject(body.data) ? body.data.id : undefined, 'X Ads');
  return { summary: 'X accepted the campaign status change.', items: [{ id: v.campaignId, status: status(v) }] };
});
add('x-ads', 'read-spend', 'Read campaign spend', 'read', [account, field('campaignIds', 'Campaign IDs separated by commas'), ...dateFields.map(field => ({ ...field, help: 'UTC calendar dates, inclusive. Maximum seven days.' }))], 'Read total on-X campaign spend for a UTC date range. Maximum seven days per synchronous request, up to 20 selected campaigns.', async (c, v, env) => {
  const range = dates(v);
  if (Date.parse(range.exclusiveEnd) - Date.parse(range.start) > 7 * 86400000) throw new ProviderError('X synchronous reports support a maximum seven-day range in this connector.');
  const ids = required(v, 'campaignIds').split(',').map(id => id.trim());
  if (ids.length > 20 || ids.some(id => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new ProviderError('Provide up to 20 valid campaign IDs separated by commas.');
  // TOTAL accepts UTC boundaries; DAY would require midnight in the account's own timezone.
  const query = new URLSearchParams({ entity: 'CAMPAIGN', entity_ids: ids.join(','), start_time: `${range.start}T00:00:00Z`, end_time: range.exclusiveEnd, granularity: 'TOTAL', placement: 'ALL_ON_TWITTER', metric_groups: 'BILLING,ENGAGEMENT' });
  const body = await xRequest(c, env, `stats/accounts/${key(v, 'accountId')}?${query}`);
  const rows: Record<string, string | number>[] = [];
  for (const item of entries(body.data, 'X Ads')) {
    for (const segment of entries(item.id_data, 'X Ads')) {
      if (!isObject(segment.metrics)) throw new ProviderError('X returned unexpected report metrics.', 502);
      const metrics = segment.metrics;
      if (!Array.isArray(metrics.billed_charge_local_micro)) throw new ProviderError('X did not return billing metrics for these campaigns.', 502);
      metrics.billed_charge_local_micro.forEach((amount, index) => {
        const micro = Number(amount);
        if (!Number.isFinite(micro)) throw new ProviderError('X returned an invalid spend amount.', 502);
        rows.push({ campaign: string(item.id), startDate: range.start, endDate: range.end, spend: micro / 1_000_000, impressions: Array.isArray(metrics.impressions) ? string(metrics.impressions[index]) : '', engagements: Array.isArray(metrics.engagements) ? string(metrics.engagements[index]) : '' });
      });
    }
  }
  return { summary: 'X on-platform campaign spend in account currency for the UTC range (excludes other placements; recent billing amounts can change).', items: rows.slice(0, 100) };
});
add('x-ads', 'send-conversion', 'Send conversion event', 'write', [field('pixelId', 'X website tag / pixel ID'), field('eventId', 'Configured conversion event ID'), field('conversionId', 'Stable conversion ID for deduplication'), field('clickId', 'Original X click ID (twclid)'), ...eventFields], 'Upload one conversion using X Conversions API access and an existing event source. OAuth 1.0a credentials must have measurement permission.', async (c, v, env) => {
  const body = await xRequest(c, env, `measurement/conversions/${key(v, 'pixelId')}`, 'POST', undefined, { conversions: [{ conversion_time: timestamp(v, 'eventTime'), event_id: required(v, 'eventId'), conversion_id: required(v, 'conversionId'), identifiers: [{ twclid: required(v, 'clickId') }], value: String(numeric(v, 'value')), price_currency: isoCurrency(v) }] });
  if (isObject(body.data)) check(body.data, 'X Ads');
  if (Array.isArray(body.data)) for (const item of body.data) if (isObject(item)) check(item, 'X Ads');
  if (!isObject(body.data) || body.data.conversions_processed !== 1) throw new ProviderError('X did not confirm that the conversion was processed. Check the platform before retrying.', 502);
  return { summary: 'X accepted the conversion upload. Matching and attribution are processed asynchronously.' };
});

// Reddit Ads v3 uses an approved adsedit grant in addition to adsread.
async function rdRequest(c: Credential, env: NodeJS.ProcessEnv, path: string, method = 'GET', data?: unknown) {
  const userAgent = env.REDDIT_USER_AGENT || 'web:connector:0.1.0';
  if (/[\r\n]/.test(userAgent)) throw new ProviderError('REDDIT_USER_AGENT must be a single line.');
  return check(await apiJson('Reddit Ads', `https://ads-api.reddit.com/api/v3/${path}`, { method, headers: { ...bearer(c), 'user-agent': userAgent, ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify({ data }) }) }), 'Reddit Ads');
}
const rdAccount = (v: ActionValues) => `ad_accounts/${key(v, 'accountId')}`;
add('reddit-ads', 'list-campaigns', 'List campaigns', 'read', [account], 'Read the first page of campaigns for an approved Reddit advertising account.', async (c, v, env) => {
  const body = await rdRequest(c, env, `${rdAccount(v)}/campaigns`);
  return { summary: 'Reddit campaigns (first page, up to 100).', items: entries(body.data, 'Reddit Ads').map(row => ({ id: string(row.id), name: string(row.name), status: string(row.configured_status), objective: string(row.objective) })) };
});
add('reddit-ads', 'create-campaign', 'Create paused traffic campaign', 'write', [account, title, budget, field('startTime', 'Campaign start time with timezone', 'datetime')], 'Create a paused Reddit traffic campaign. Approved ads, ad groups, targeting, and billing must be configured before launch.', async (c, v, env) => {
  const body = await rdRequest(c, env, `${rdAccount(v)}/campaigns`, 'POST', { name: required(v, 'name'), objective: 'TRAFFIC', goal_type: 'DAILY_SPEND', goal_value: micros(v), start_time: timestamp(v, 'startTime'), configured_status: 'PAUSED' });
  return { summary: 'Paused Reddit campaign created.', items: [{ id: confirmedId(isObject(body.data) ? body.data.id : undefined, 'Reddit Ads'), status: 'PAUSED' }] };
});
add('reddit-ads', 'set-campaign-status', 'Launch or pause campaign', 'write', [account, campaign, stateField], 'Enable or pause a configured Reddit campaign. Enabling may start ad spend if child ads and billing are eligible.', async (c, v, env) => {
  const value = status(v);
  const body = await rdRequest(c, env, `${rdAccount(v)}/campaigns/${key(v, 'campaignId')}`, 'PATCH', { configured_status: value });
  confirmedId(isObject(body.data) ? body.data.id : undefined, 'Reddit Ads');
  return { summary: 'Reddit accepted the campaign status change.', items: [{ id: v.campaignId, status: value }] };
});
add('reddit-ads', 'read-spend', 'Read campaign spend', 'read', [account, ...dateFields], 'Read a campaign-level spend report through Reddit Ads v3. Results are limited to the first 100 rows.', async (c, v, env) => {
  const range = dates(v);
  const body = await rdRequest(c, env, `${rdAccount(v)}/reports`, 'POST', { starts_at: `${range.start}T00:00:00Z`, ends_at: range.exclusiveEnd, fields: ['SPEND', 'IMPRESSIONS', 'CLICKS'], breakdowns: ['campaign_id', 'date'], time_zone_id: 'GMT' });
  return { summary: 'Reddit daily campaign spend (first 100 rows; amounts use the API reporting unit).', items: entries(isObject(body.data) ? body.data.metrics : undefined, 'Reddit Ads').map(row => ({ campaign: string(row.CAMPAIGN_ID ?? row.campaign_id), date: string(row.date), spend: string(row.SPEND ?? row.spend), impressions: string(row.IMPRESSIONS ?? row.impressions), clicks: string(row.CLICKS ?? row.clicks) })) };
});
add('reddit-ads', 'send-conversion', 'Send purchase conversion', 'write', [field('pixelId', 'Reddit Events Manager pixel ID'), field('conversionId', 'Stable conversion ID for deduplication'), field('clickId', 'Original Reddit click ID'), ...eventFields], 'Send a website PURCHASE event using a dedicated Events Manager token. Configure REDDIT_CONVERSIONS_TOKEN; ads OAuth alone does not grant this credential.', async (_c, v, env) => {
  const time = Date.parse(timestamp(v, 'eventTime'));
  if (time > Date.now() + 60_000 || time < Date.now() - 7 * 86400000) throw new ProviderError('Reddit conversion time must be within the last seven days.');
  const credential = { accessToken: envValue(env, 'REDDIT_CONVERSIONS_TOKEN') };
  const body = await rdRequest(credential, env, `pixels/${key(v, 'pixelId')}/conversion_events`, 'POST', { events: [{
    event_at: time, action_source: 'WEBSITE', click_id: required(v, 'clickId'), type: { tracking_type: 'PURCHASE' },
    metadata: { conversion_id: createHash('sha256').update(required(v, 'conversionId')).digest('hex'), currency: isoCurrency(v), value: numeric(v, 'value') },
  }] });
  if (isObject(body.data)) check(body.data, 'Reddit Ads');
  return { summary: 'Reddit accepted the purchase conversion upload. Matching and attribution are processed asynchronously.' };
});
