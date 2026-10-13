import { randomUUID } from 'node:crypto';
import { apiJson, bearer, records, required, string } from './action-http';
import type { ActionAdapter, ActionField, ActionValues } from './action-types';
import { isObject } from './provider-http';
import { ProviderError, type Credential } from './provider-types';

const ADS = 'https://googleads.googleapis.com/v25';
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const accountFields: ActionField[] = [
  { name: 'customerId', label: 'Google Ads customer ID', type: 'text', required: true, help: 'The advertising account, with or without hyphens.' },
  { name: 'loginCustomerId', label: 'Manager customer ID (optional)', type: 'text', help: 'Set when accessing this account through a Google Ads manager.' },
];
const dateFields: ActionField[] = [
  { name: 'startDate', label: 'Start date', type: 'text', placeholder: 'YYYY-MM-DD', required: true },
  { name: 'endDate', label: 'End date', type: 'text', placeholder: 'YYYY-MM-DD', required: true, help: 'Inclusive. Request up to 366 days; reports show at most 100 rows.' },
];

function digits(value: string, label: string): string {
  const cleaned = value.replaceAll('-', '');
  if (!/^\d{1,20}$/.test(cleaned)) throw new ProviderError(`${label} must contain only digits, with optional hyphens.`);
  return cleaned;
}

function id(values: ActionValues, field: string, label: string): string {
  const result = required(values, field, label);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(result)) throw new ProviderError(`${label} is invalid.`);
  return result;
}

function choice(values: ActionValues, field: string, choices: string[], fallback?: string): string {
  const value = values[field]?.trim() || fallback;
  if (!value || !choices.includes(value)) throw new ProviderError(`Choose a valid ${field}.`);
  return value;
}

function dates(values: ActionValues): { startDate: string; endDate: string } {
  const startDate = required(values, 'startDate', 'Start date');
  const endDate = required(values, 'endDate', 'End date');
  for (const value of [startDate, endDate]) {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
      throw new ProviderError('Dates must be valid calendar dates in YYYY-MM-DD format.');
    }
  }
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
  if (days < 0 || days >= 366) throw new ProviderError('Use an ordered date range covering at most 366 days.');
  return { startDate, endDate };
}

function checked(body: Record<string, unknown>, provider = 'Google'): Record<string, unknown> {
  if (body.error !== undefined || body.partialFailureError !== undefined || (Array.isArray(body.errors) && body.errors.length > 0)) {
    throw new ProviderError(`${provider} reported a failed or partially failed operation. Check the platform before retrying a write.`, 502);
  }
  return body;
}

function responseId(body: Record<string, unknown>, key: string, provider: string): string {
  const value = string(body[key]);
  if (!value) throw new ProviderError(`${provider} did not confirm the operation. Check the platform before retrying.`, 502);
  return value;
}

async function googleJson(name: string, url: string, credential: Credential, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return checked(await apiJson(name, url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...bearer(credential), ...extraHeaders, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), name);
}

function adsConfig(credential: Credential, values: ActionValues, env: NodeJS.ProcessEnv) {
  const customerId = digits(required(values, 'customerId', 'Customer ID'), 'Customer ID');
  const developerToken = env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim();
  if (!developerToken || /[\r\n]/.test(developerToken)) throw new ProviderError('Configure GOOGLE_ADS_DEVELOPER_TOKEN before using Google Ads.');
  const headers: Record<string, string> = { ...bearer(credential), 'developer-token': developerToken };
  if (values.loginCustomerId?.trim()) headers['login-customer-id'] = digits(values.loginCustomerId.trim(), 'Manager customer ID');
  return { customerId, headers };
}

async function adsRequest(credential: Credential, values: ActionValues, env: NodeJS.ProcessEnv, suffix: string, payload: unknown) {
  const { customerId, headers } = adsConfig(credential, values, env);
  return checked(await apiJson('Google Ads', `${ADS}/customers/${customerId}${suffix}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }), 'Google Ads');
}

function micros(value: string): string {
  if (!/^\d{1,10}(?:\.\d{1,6})?$/.test(value)) throw new ProviderError('Daily budget must be a positive amount with at most six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (result <= 0n) throw new ProviderError('Daily budget must be greater than zero.');
  return result.toString();
}

function displayMicros(value: unknown): string {
  const raw = string(value, '0');
  if (!/^-?\d+$/.test(raw)) return '';
  const amount = BigInt(raw);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, '0')}`;
}

function videoData(value: string): { bytes: Buffer; mime: string } {
  // Check the encoded size before allocating a decoded copy. URLs are never fetched.
  if (value.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4 + 100) throw new ProviderError('Choose a video of at most 20 MiB.');
  const match = /^data:(video\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || !match[2] || match[2].length % 4 !== 0) throw new ProviderError('Choose a local video file encoded as a video data URL.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_VIDEO_BYTES || bytes.toString('base64') !== match[2]) throw new ProviderError('Choose a valid video of at most 20 MiB.');
  return { bytes, mime: match[1] };
}

export const googleActions: ActionAdapter[] = [
  {
    provider: 'youtube',
    definition: {
      id: 'publish-video', label: 'Upload a video', group: 'publishing', kind: 'write', schedulable: true,
      description: 'Upload a local video to the channel selected during Google consent. YouTube processes it after accepting the upload.',
      fields: [
        { name: 'title', label: 'Video title', type: 'text', required: true },
        { name: 'description', label: 'Description', type: 'textarea' },
        { name: 'media', label: 'Video file', type: 'file', required: true, help: 'Local video file, at most 20 MiB.' },
        { name: 'privacy', label: 'Visibility', type: 'select', required: true, default: 'private', options: [
          { value: 'private', label: 'Private' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'public', label: 'Public' },
        ] },
        { name: 'madeForKids', label: 'Is this video made for kids?', type: 'select', required: true, options: [
          { value: 'false', label: 'No' }, { value: 'true', label: 'Yes' },
        ] },
        { name: 'categoryId', label: 'YouTube category ID', type: 'text', default: '22', help: '22 is People & Blogs. Use a valid YouTube video category for your content.' },
      ],
    },
    execute: async (credential, values) => {
      const title = required(values, 'title', 'Video title');
      const description = values.description ?? '';
      if (title.length > 100 || description.length > 5000 || /[<>]/.test(title + description)) throw new ProviderError('Use a title of at most 100 characters and a description of at most 5,000 characters, without angle brackets.');
      const privacyStatus = choice(values, 'privacy', ['private', 'unlisted', 'public'], 'private');
      const madeForKids = choice(values, 'madeForKids', ['true', 'false']);
      const categoryId = digits(values.categoryId?.trim() || '22', 'Category ID');
      const { bytes, mime } = videoData(required(values, 'media', 'Video file'));
      const boundary = `connector_${randomUUID()}`;
      const metadata = { snippet: { title, description, categoryId }, status: { privacyStatus, selfDeclaredMadeForKids: madeForKids === 'true' } };
      const payload = Uint8Array.from(Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
        bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]));
      const body = checked(await apiJson('YouTube', 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status&notifySubscribers=false', {
        method: 'POST', headers: { ...bearer(credential), 'content-type': `multipart/related; boundary=${boundary}` }, body: payload,
      }), 'YouTube');
      const videoId = responseId(body, 'id', 'YouTube');
      const status = isObject(body.status) ? body.status : {};
      if (['failed', 'rejected', 'deleted'].includes(string(status.uploadStatus))) throw new ProviderError('YouTube rejected or failed this upload. Check YouTube Studio for details.', 502);
      const visibility = string(status.privacyStatus, privacyStatus);
      return { summary: `YouTube accepted video ${videoId} (${visibility}). Processing may still be underway.`, items: [{ videoId, visibility, processing: string(status.uploadStatus, 'pending') }], link: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` };
    },
  },
  {
    provider: 'youtube',
    definition: { id: 'list-comments', label: 'Read video comments', group: 'inbox', kind: 'read', description: 'Read the latest 100 published top-level comments on a video. Use a returned comment ID to reply.', fields: [{ name: 'videoId', label: 'YouTube video ID', type: 'text', required: true }] },
    execute: async (credential, values) => {
      const params = new URLSearchParams({ part: 'snippet', videoId: id(values, 'videoId', 'Video ID'), maxResults: '100', order: 'time', textFormat: 'plainText' });
      const body = await googleJson('YouTube', `https://youtube.googleapis.com/youtube/v3/commentThreads?${params}`, credential);
      const items = records(body.items).flatMap((thread) => {
        const snippet = isObject(thread.snippet) ? thread.snippet : {};
        const comment = isObject(snippet.topLevelComment) ? snippet.topLevelComment : {};
        const details = isObject(comment.snippet) ? comment.snippet : {};
        return string(comment.id) ? [{ commentId: string(comment.id), author: string(details.authorDisplayName), text: string(details.textOriginal ?? details.textDisplay), publishedAt: string(details.publishedAt), replies: string(snippet.totalReplyCount) }] : [];
      });
      return { summary: `Returned ${items.length} recent published comments.`, items };
    },
  },
  {
    provider: 'youtube',
    definition: { id: 'reply-comment', label: 'Reply to a comment', group: 'inbox', kind: 'write', description: 'Post a public reply to an existing top-level YouTube comment.', fields: [{ name: 'commentId', label: 'Parent comment ID', type: 'text', required: true }, { name: 'text', label: 'Reply', type: 'textarea', required: true }] },
    execute: async (credential, values) => {
      const text = required(values, 'text', 'Reply');
      if (text.length > 10_000) throw new ProviderError('Keep the reply within 10,000 characters.');
      const body = await googleJson('YouTube', 'https://youtube.googleapis.com/youtube/v3/comments?part=snippet', credential, { snippet: { parentId: id(values, 'commentId', 'Comment ID'), textOriginal: text } });
      return { summary: 'YouTube published your reply.', items: [{ commentId: responseId(body, 'id', 'YouTube') }] };
    },
  },
  {
    provider: 'youtube',
    definition: { id: 'channel-analytics', label: 'Read channel analytics', group: 'analytics', kind: 'read', description: 'Read daily views and estimated watch minutes for your connected YouTube channel.', fields: dateFields },
    execute: async (credential, values) => {
      const params = new URLSearchParams({ ids: 'channel==MINE', ...dates(values), metrics: 'views,estimatedMinutesWatched', dimensions: 'day', sort: 'day', maxResults: '100' });
      const body = await googleJson('YouTube Analytics', `https://youtubeanalytics.googleapis.com/v2/reports?${params}`, credential);
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 100).filter(Array.isArray) : [];
      return { summary: `Returned ${rows.length} daily YouTube analytics rows.`, items: rows.map((row) => ({ date: string(row[0]), views: string(row[1]), estimatedMinutesWatched: string(row[2]) })) };
    },
  },
  {
    provider: 'google-ads',
    definition: { id: 'list-campaigns', label: 'List campaigns', group: 'advertising', kind: 'read', description: 'List up to 100 campaigns and their current status.', fields: accountFields },
    execute: async (credential, values, env) => {
      const body = await adsRequest(credential, values, env, '/googleAds:search', { query: "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id LIMIT 100" });
      const items = records(body.results).map((row) => {
        const campaign = isObject(row.campaign) ? row.campaign : {};
        return { campaignId: string(campaign.id), name: string(campaign.name), status: string(campaign.status), channel: string(campaign.advertisingChannelType) };
      });
      return { summary: `Returned ${items.length} Google Ads campaigns.`, items };
    },
  },
  {
    provider: 'google-ads',
    definition: {
      id: 'create-search-campaign', label: 'Create a paused Search campaign', group: 'advertising', kind: 'write',
      description: 'Create a paused Search campaign and its average daily budget together. Configure ad groups, keywords, bids and ads in Google Ads before enabling delivery.',
      fields: [...accountFields,
        { name: 'name', label: 'Campaign name', type: 'text', required: true },
        { name: 'dailyBudget', label: 'Average daily budget', type: 'number', required: true, help: 'In the Google Ads account currency. Daily spend can exceed this average under Google’s budget rules.' },
        { name: 'euPoliticalAdvertising', label: 'Does this campaign contain EU political advertising?', type: 'select', required: true, options: [
          { value: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', label: 'No' }, { value: 'CONTAINS_EU_POLITICAL_ADVERTISING', label: 'Yes' },
        ] },
      ],
    },
    execute: async (credential, values, env) => {
      const { customerId } = adsConfig(credential, values, env);
      const name = required(values, 'name', 'Campaign name');
      if (name.length > 128) throw new ProviderError('Keep the campaign name within 128 characters.');
      const amountMicros = micros(required(values, 'dailyBudget', 'Daily budget'));
      const containsEuPoliticalAdvertising = choice(values, 'euPoliticalAdvertising', ['DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', 'CONTAINS_EU_POLITICAL_ADVERTISING']);
      const budgetResource = `customers/${customerId}/campaignBudgets/-1`;
      const body = await adsRequest(credential, values, env, '/googleAds:mutate', {
        partialFailure: false,
        mutateOperations: [
          { campaignBudgetOperation: { create: { resourceName: budgetResource, name: `${name} budget`, amountMicros, deliveryMethod: 'STANDARD', period: 'DAILY', explicitlyShared: false } } },
          { campaignOperation: { create: { name, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budgetResource, manualCpc: {}, containsEuPoliticalAdvertising, networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false } } } },
        ],
      });
      const responses = records(body.mutateOperationResponses);
      const budget = responses.find((row) => isObject(row.campaignBudgetResult))?.campaignBudgetResult;
      const campaign = responses.find((row) => isObject(row.campaignResult))?.campaignResult;
      if (!isObject(budget) || !isObject(campaign)) throw new ProviderError('Google Ads did not confirm both campaign and budget. Check Google Ads before retrying.', 502);
      return { summary: 'Created a paused Search campaign and budget. Add ad groups, keywords, bids and ads in Google Ads before enabling it.', items: [{ campaign: responseId(campaign, 'resourceName', 'Google Ads'), budget: responseId(budget, 'resourceName', 'Google Ads'), status: 'PAUSED', dailyBudget: values.dailyBudget }] };
    },
  },
  {
    provider: 'google-ads',
    definition: { id: 'set-campaign-status', label: 'Enable or pause a campaign', group: 'advertising', kind: 'write', description: 'Enable a fully configured campaign to allow delivery and spending, or pause it. Account billing and ad approvals must be ready for delivery.', fields: [...accountFields, { name: 'campaignId', label: 'Campaign ID', type: 'text', required: true }, { name: 'status', label: 'New status', type: 'select', required: true, default: 'PAUSED', options: [{ value: 'PAUSED', label: 'Pause' }, { value: 'ENABLED', label: 'Enable delivery and spending' }] }] },
    execute: async (credential, values, env) => {
      const { customerId } = adsConfig(credential, values, env);
      const campaignId = digits(required(values, 'campaignId', 'Campaign ID'), 'Campaign ID');
      const status = choice(values, 'status', ['PAUSED', 'ENABLED']);
      const body = await adsRequest(credential, values, env, '/campaigns:mutate', { partialFailure: false, operations: [{ update: { resourceName: `customers/${customerId}/campaigns/${campaignId}`, status }, updateMask: 'status' }] });
      const result = records(body.results)[0];
      if (!result) throw new ProviderError('Google Ads did not confirm the campaign status. Check the platform before retrying.', 502);
      return { summary: status === 'ENABLED' ? 'Campaign enabled. Eligible ads can now deliver and spend.' : 'Campaign paused.', items: [{ campaign: responseId(result, 'resourceName', 'Google Ads'), status }] };
    },
  },
  {
    provider: 'google-ads',
    definition: { id: 'campaign-spend', label: 'Read campaign spend', group: 'analytics', kind: 'read', description: 'Read campaign spend, clicks, impressions and conversions by day in the account currency and time zone. Shows the latest 100 campaign-day rows.', fields: [...accountFields, ...dateFields] },
    execute: async (credential, values, env) => {
      const { startDate, endDate } = dates(values);
      const body = await adsRequest(credential, values, env, '/googleAds:search', { query: `SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, customer.currency_code FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND campaign.status != 'REMOVED' ORDER BY segments.date DESC, campaign.id LIMIT 100` });
      const items = records(body.results).map((row) => {
        const campaign = isObject(row.campaign) ? row.campaign : {};
        const metrics = isObject(row.metrics) ? row.metrics : {};
        const customer = isObject(row.customer) ? row.customer : {};
        const segments = isObject(row.segments) ? row.segments : {};
        return { date: string(segments.date), campaignId: string(campaign.id), campaign: string(campaign.name), spend: displayMicros(metrics.costMicros), currency: string(customer.currencyCode), clicks: string(metrics.clicks, '0'), impressions: string(metrics.impressions, '0'), conversions: string(metrics.conversions, '0') };
      });
      return { summary: `Returned ${items.length} campaign-day spend rows. This preview is not a complete account total.`, items };
    },
  },
  {
    provider: 'google-ads',
    definition: {
      id: 'upload-conversion', label: 'Upload a click conversion', group: 'advertising', kind: 'write',
      description: 'Upload one offline conversion tied to a Google click ID. Requires an eligible import conversion action and an accurate consent declaration.',
      fields: [...accountFields,
        { name: 'gclid', label: 'Google click ID (GCLID)', type: 'text', required: true },
        { name: 'conversionAction', label: 'Conversion action', type: 'text', required: true, help: 'Action ID or full customers/123/conversionActions/456 resource. For cross-account tracking, use the conversion owner’s full resource.' },
        { name: 'conversionDateTime', label: 'Conversion date and time with UTC offset', type: 'text', required: true, placeholder: '2026-10-13 12:00:00+08:00' },
        { name: 'value', label: 'Conversion value', type: 'number', required: true },
        { name: 'currency', label: 'Currency code', type: 'text', required: true, placeholder: 'USD' },
        { name: 'orderId', label: 'Order ID (optional)', type: 'text', help: 'A stable unique transaction ID helps Google detect duplicate conversions.' },
        { name: 'adUserDataConsent', label: 'Consent to send user data for advertising', type: 'select', required: true, options: [{ value: 'GRANTED', label: 'Granted' }, { value: 'DENIED', label: 'Denied' }], help: 'Use the actual consent collected for this conversion.' },
      ],
    },
    execute: async (credential, values, env) => {
      const { customerId } = adsConfig(credential, values, env);
      const gclid = required(values, 'gclid', 'Google click ID');
      if (gclid.length > 2000 || /\s/.test(gclid)) throw new ProviderError('Enter a valid Google click ID without whitespace.');
      const action = required(values, 'conversionAction', 'Conversion action');
      const conversionAction = /^\d+$/.test(action) ? `customers/${customerId}/conversionActions/${action}` : action;
      if (!/^customers\/\d+\/conversionActions\/\d+$/.test(conversionAction)) throw new ProviderError('Enter an action ID or a valid conversion action resource.');
      const conversionDateTime = required(values, 'conversionDateTime', 'Conversion time');
      if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d[+-]\d{2}:[0-5]\d$/.test(conversionDateTime) || !Number.isFinite(Date.parse(conversionDateTime.replace(' ', 'T')))) throw new ProviderError('Use a conversion time such as 2026-10-13 12:00:00+08:00 with an explicit UTC offset.');
      dates({ startDate: conversionDateTime.slice(0, 10), endDate: conversionDateTime.slice(0, 10) });
      const conversionValue = Number(required(values, 'value', 'Conversion value'));
      if (!Number.isFinite(conversionValue) || conversionValue < 0) throw new ProviderError('Conversion value must be zero or greater.');
      const currencyCode = required(values, 'currency', 'Currency code').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) throw new ProviderError('Use a three-letter currency code.');
      const adUserData = choice(values, 'adUserDataConsent', ['GRANTED', 'DENIED']);
      const orderId = values.orderId?.trim();
      if (orderId && orderId.length > 256) throw new ProviderError('Keep the order ID within 256 characters.');
      const body = await adsRequest(credential, values, env, ':uploadClickConversions', { partialFailure: true, conversions: [{ gclid, conversionAction, conversionDateTime, conversionValue, currencyCode, consent: { adUserData }, ...(orderId ? { orderId } : {}) }] });
      const result = records(body.results)[0];
      if (!result || !string(result.conversionAction)) throw new ProviderError('Google Ads did not confirm the conversion. Check upload diagnostics before retrying.', 502);
      return { summary: 'Google Ads accepted the conversion upload. Attribution and reporting may take additional processing time.', items: [{ conversionAction: string(result.conversionAction), conversionDateTime: string(result.conversionDateTime, conversionDateTime), value: conversionValue, currency: currencyCode }] };
    },
  },
  {
    provider: 'google-analytics',
    definition: { id: 'traffic-report', label: 'Read daily website traffic', group: 'analytics', kind: 'read', description: 'Read GA4 active users, sessions and page/screen views by day. Requires the Google Analytics Data API.', fields: [{ name: 'propertyId', label: 'GA4 property ID', type: 'text', required: true, help: 'Numeric ID from the connection’s property list.' }, ...dateFields] },
    execute: async (credential, values) => {
      const propertyId = digits(required(values, 'propertyId', 'Property ID').replace(/^properties\//, ''), 'Property ID');
      const body = await googleJson('Google Analytics', `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, credential, { dateRanges: [dates(values)], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: '100' });
      const items = records(body.rows).map((row) => {
        const dimensions = records(row.dimensionValues); const metrics = records(row.metricValues);
        return { date: string(dimensions[0]?.value), activeUsers: string(metrics[0]?.value), sessions: string(metrics[1]?.value), views: string(metrics[2]?.value) };
      });
      return { summary: `Returned ${items.length} daily GA4 rows.`, items };
    },
  },
  {
    provider: 'search-console',
    definition: { id: 'search-performance', label: 'Read search performance', group: 'analytics', kind: 'read', description: 'Read daily Google web search clicks, impressions, click-through rate and average position for a Search Console property.', fields: [{ name: 'siteUrl', label: 'Search Console property', type: 'text', required: true, placeholder: 'sc-domain:example.com or https://example.com/' }, ...dateFields] },
    execute: async (credential, values) => {
      const siteUrl = required(values, 'siteUrl', 'Search Console property');
      if (siteUrl.length > 2000 || !/^(sc-domain:[A-Za-z0-9.-]+|https?:\/\/\S+)$/.test(siteUrl)) throw new ProviderError('Use the exact domain or URL-prefix property ID shown in Search Console.');
      const body = await googleJson('Google Search Console', `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, credential, { ...dates(values), dimensions: ['date'], type: 'web', rowLimit: 100, dataState: 'final' });
      const items = records(body.rows).map((row) => ({ date: Array.isArray(row.keys) ? string(row.keys[0]) : '', clicks: string(row.clicks), impressions: string(row.impressions), ctr: string(row.ctr), averagePosition: string(row.position) }));
      return { summary: `Returned ${items.length} daily Search Console rows. Dates use Search Console’s Pacific time zone.`, items };
    },
  },
];
