import { apiRequest, bearer, required, string } from './action-http';
import type { ActionAdapter, ActionField, ActionValues } from './action-types';
import { isObject } from './provider-http';
import { ProviderError, type Credential } from './provider-types';
import { snapchatAdAccounts, snapchatAdsFailure, snapchatAdsId, snapchatAdsObject, snapchatAdsOrigin, snapchatAdsRows } from './providers-snapchat-ads';

// Campaigns use POST envelopes and targeted JSON PATCH. Do not use PUT: omitted
// fields can reset campaign configuration. Monetary values use account currency.
export const snapchatAdsActions: ActionAdapter[] = [];
const field = (name: string, label: string, help?: string, type: ActionField['type'] = 'text'): ActionField => ({ name, label, type, required: true, ...(help ? { help } : {}) });
const account = field('accountId', 'Snapchat advertising account ID', 'The advertising account UUID, not the organization or Public Profile ID.');
const campaign = field('campaignId', 'Snapchat campaign ID');
const budget = field('dailyBudget', 'Daily campaign spending cap', 'In the selected account currency; up to six decimal places. Snapchat minimums apply.', 'number');
const currency = field('currency', 'Account currency', 'Three-letter currency code, for example USD. Must match the advertising account.');
const status: ActionField = { name: 'status', label: 'Campaign status', type: 'select', required: true, options: [{ value: 'ACTIVE', label: 'Launch / enable (may start spending)' }, { value: 'PAUSED', label: 'Pause' }] };
function add(id: string, label: string, kind: 'read' | 'write', fields: ActionField[], description: string, execute: ActionAdapter['execute']) {
  snapchatAdsActions.push({ provider: 'snapchat-ads', definition: { id, label, kind, fields, group: 'advertising', description }, execute });
}
const id = (values: ActionValues, key: string) => snapchatAdsId(required(values, key));
async function request(c: Credential, path: string, method = 'GET', body?: unknown) {
  const result = await apiRequest('Snapchat Ads', `${snapchatAdsOrigin}${path}`, {
    method, headers: { ...bearer(c), ...(body === undefined ? {} : { 'content-type': method === 'PATCH' ? 'application/json-patch+json' : 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return snapchatAdsObject(result.body);
}
function selectedCampaign(value: Record<string, unknown>, accountId: string, campaignId?: string) {
  snapchatAdsId(value.id);
  if (value.ad_account_id !== accountId || (campaignId && value.id !== campaignId)) snapchatAdsFailure();
  return value;
}
function oneCampaign(body: unknown, accountId: string, campaignId?: string) {
  const rows = snapchatAdsRows(body, 'campaigns', 'campaign');
  if (rows.length !== 1) snapchatAdsFailure();
  return selectedCampaign(rows[0], accountId, campaignId);
}
function micros(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,30}$/.test(value)) return value;
  snapchatAdsFailure();
}
function amount(value: string | null): string | null {
  if (value === null) return null;
  const n = BigInt(value), decimals = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${n / 1_000_000n}${decimals ? `.${decimals}` : ''}`;
}
function money(values: ActionValues) {
  const raw = required(values, 'dailyBudget');
  if (!/^\d{1,10}(?:\.\d{1,6})?$/.test(raw)) throw new ProviderError('Daily spending cap must be a positive amount with at most six decimal places.');
  const [whole, fraction = ''] = raw.split('.'), value = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProviderError('Daily spending cap must be positive and fit a safe number of micro-currency units.');
  const code = required(values, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new ProviderError('Currency must be a three-letter code matching the account.');
  return { micro: Number(value), currency: code };
}
async function accountDetails(c: Credential, accountId: string) {
  const rows = snapchatAdsRows(await request(c, `adaccounts/${accountId}`), 'adaccounts', 'adaccount');
  if (rows.length !== 1 || rows[0].id !== accountId || typeof rows[0].currency !== 'string' || !/^[A-Z]{3}$/.test(rows[0].currency)) snapchatAdsFailure();
  return { currency: rows[0].currency, timezone: typeof rows[0].timezone === 'string' ? rows[0].timezone.slice(0, 100) : null };
}
async function checkCurrency(c: Credential, accountId: string, expected: string) {
  const account = await accountDetails(c, accountId);
  if (account.currency !== expected) throw new ProviderError(`Currency must match this Snapchat advertising account (${account.currency}). No campaign change was sent.`);
}
function timestamp(raw: string, label: string): string {
  // Explicit zones avoid silently treating the user's local date as UTC.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new ProviderError(`${label} must be an ISO 8601 timestamp with Z or a time-zone offset.`);
  const day = raw.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new ProviderError(`${label} must contain a valid calendar date.`);
  return new Date(raw).toISOString();
}
function reportDays(start: string, end: string, timezone: string | null) {
  if (!timezone) throw new ProviderError('Snapchat did not return the account time zone needed for reporting. Check its time zone in Ads Manager.');
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw new ProviderError('Snapchat returned an unsupported account time zone. Check its time zone in Ads Manager.'); }
  const localDay = (value: string) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(value)).map(part => [part.type, part.value]));
    if (parts.hour !== '00' || parts.minute !== '00' || parts.second !== '00' || Date.parse(value) % 1000) throw new ProviderError(`Reporting must start and end at midnight in the advertising account time zone (${timezone}). Use timestamps with the correct time-zone offset.`);
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const first = localDay(start), last = localDay(end);
  const days = (Date.parse(last) - Date.parse(first)) / 86_400_000;
  if (days < 1 || days > 31 || first < '2013-01-01') throw new ProviderError('Use an ordered reporting window of 1 to 31 account-local days, starting on or after 2013-01-01.');
}
function confirmChange(body: unknown, accountId: string, campaignId: string | undefined, expected: { status?: string; dailyBudget?: number }) {
  const result = oneCampaign(body, accountId, campaignId);
  if ((expected.status && result.status !== expected.status) || (expected.dailyBudget !== undefined && micros(result.daily_budget_micro) !== String(expected.dailyBudget))) snapchatAdsFailure();
  return result;
}

add('list-ad-accounts', 'List advertising accounts', 'read', [], 'Read up to 100 Snapchat advertising accounts visible to the authorizing user, including currency, time zone and account roles.', async c => {
  const rows = snapchatAdAccounts(await request(c, 'me/organizations?with_ad_accounts=true'));
  return {
    summary: `Snapchat advertising accounts (first ${Math.min(rows.length, 100)} returned).${rows.length > 100 ? ' More accounts exist beyond this preview.' : ''}`,
    items: rows.slice(0, 100).map(row => ({ id: snapchatAdsId(row.id), name: string(row.name), currency: string(row.currency), timezone: string(row.timezone), roles: Array.isArray(row.roles) ? row.roles.filter(role => typeof role === 'string').slice(0, 20).join(', ').slice(0, 300) : '' })),
  };
});

add('list-campaigns', 'List campaigns', 'read', [account], 'Read the first 100 campaigns in the chosen Snapchat advertising account. This preview is not a complete inventory.', async (c, v) => {
  const accountId = id(v, 'accountId');
  const body = await request(c, `adaccounts/${accountId}/campaigns?limit=100&sort=updated_at-desc`);
  const rows = snapchatAdsRows(body, 'campaigns', 'campaign');
  const more = rows.length > 100 || (isObject(body.paging) && !!body.paging.next_link);
  return {
    summary: `Snapchat campaigns (first ${Math.min(rows.length, 100)} returned; budget caps are account-currency microunits).${more ? ' More campaigns exist beyond this preview.' : ''}`,
    items: rows.slice(0, 100).map(row => {
      selectedCampaign(row, accountId);
      return { id: snapchatAdsId(row.id), accountId, name: string(row.name), status: string(row.status), objective: isObject(row.objective_v2_properties) ? string(row.objective_v2_properties.objective_v2_type) : string(row.objective), dailyBudgetMicros: micros(row.daily_budget_micro), lifetimeCapMicros: micros(row.lifetime_spend_cap_micro) };
    }),
  };
});

add('create-campaign', 'Create paused awareness campaign', 'write', [account, field('name', 'Campaign name'), budget, currency, { ...field('startTime', 'Start time', 'Optional ISO 8601 timestamp with time zone. Leave blank to use the current time; the campaign is still created paused.'), required: false }], 'Create one paused auction campaign for awareness and engagement with a daily spending cap. Ad squads, targeting, creatives, ads and billing still need configuration before delivery.', async (c, v) => {
  const accountId = id(v, 'accountId'), name = required(v, 'name'), cap = money(v);
  if (name.length > 375 || /[\r\n\0]/.test(name)) throw new ProviderError('Campaign name must be a single line of at most 375 characters.');
  const startTime = v.startTime?.trim() ? timestamp(v.startTime.trim(), 'Start time') : new Date().toISOString();
  await checkCurrency(c, accountId, cap.currency);
  const row = confirmChange(await request(c, `adaccounts/${accountId}/campaigns`, 'POST', { campaigns: [{
    name, ad_account_id: accountId, status: 'PAUSED', start_time: startTime, buy_model: 'AUCTION', creation_state: 'PUBLISHED',
    objective_v2_properties: { objective_v2_type: 'AWARENESS_AND_ENGAGEMENT' }, daily_budget_micro: cap.micro, pacing_level: 'AD_SQUAD',
  }] }), accountId, undefined, { status: 'PAUSED', dailyBudget: cap.micro });
  return { summary: 'Paused Snapchat awareness campaign created. Configure its ad squads, targeting and approved ads before enabling it.', items: [{ id: snapchatAdsId(row.id), accountId, status: 'PAUSED', dailyBudget: amount(String(cap.micro)), dailyBudgetMicros: String(cap.micro), currency: cap.currency }] };
});

add('set-campaign-status', 'Launch or pause campaign', 'write', [account, campaign, status], 'Enable or pause a Snapchat campaign. Enabling can start spending immediately when its ad squads, ads and billing are eligible.', async (c, v) => {
  const accountId = id(v, 'accountId'), campaignId = id(v, 'campaignId'), status = required(v, 'status');
  if (status !== 'ACTIVE' && status !== 'PAUSED') throw new ProviderError('Choose ACTIVE or PAUSED.');
  confirmChange(await request(c, `adaccounts/${accountId}/campaigns/${campaignId}`, 'PATCH', [{ op: 'replace', path: '/status', value: status }]), accountId, campaignId, { status });
  return { summary: 'Snapchat confirmed the campaign status change.', items: [{ id: campaignId, accountId, status }] };
});

add('set-campaign-budget', 'Change daily campaign spending cap', 'write', [account, campaign, budget, currency], 'Change an existing daily campaign spending cap. An active campaign may spend more immediately. This preserves status, lifetime caps and other campaign settings.', async (c, v) => {
  const accountId = id(v, 'accountId'), campaignId = id(v, 'campaignId'), cap = money(v);
  await checkCurrency(c, accountId, cap.currency);
  const existing = oneCampaign(await request(c, `campaigns/${campaignId}`), accountId, campaignId);
  if (micros(existing.daily_budget_micro) === null || BigInt(micros(existing.daily_budget_micro)!) <= 0n) throw new ProviderError('This action changes an existing daily campaign cap. Set up the initial daily cap in Ads Manager first; no budget change was sent.');
  confirmChange(await request(c, `adaccounts/${accountId}/campaigns/${campaignId}`, 'PATCH', [{ op: 'replace', path: '/daily_budget_micro', value: cap.micro }]), accountId, campaignId, { dailyBudget: cap.micro });
  return { summary: 'Snapchat confirmed the daily campaign spending cap. Other campaign settings were preserved.', items: [{ id: campaignId, accountId, dailyBudget: amount(String(cap.micro)), dailyBudgetMicros: String(cap.micro), currency: cap.currency }] };
});

add('read-spend', 'Read advertising spend', 'read', [account, field('startTime', 'Report start time', 'ISO 8601 timestamp at midnight in the account time zone, with the correct Z or offset; for example 2026-10-01T00:00:00+01:00 for London.'), field('endTime', 'Report end time', 'Exclusive end at midnight in the account time zone. At most 31 account-local days; the offset may change across daylight saving time.'), { ...campaign, required: false, help: 'Optional campaign UUID. Leave blank for account totals.' }], 'Read spend, impressions and swipes over 1 to 31 full days in the account time zone. Missing data is not treated as zero spend; recent metrics can change.', async (c, v) => {
  const accountId = id(v, 'accountId'), campaignId = v.campaignId?.trim() ? id(v, 'campaignId') : undefined;
  const start = timestamp(required(v, 'startTime'), 'Report start'), end = timestamp(required(v, 'endTime'), 'Report end');
  const startMs = Date.parse(start), endMs = Date.parse(end);
  if (endMs <= startMs || endMs - startMs > 32 * 86_400_000 || start < '2012-12-31T00:00:00.000Z') throw new ProviderError('Use an ordered reporting window of at most 31 account-local days, starting on or after 2013-01-01.');
  const detail = await accountDetails(c, accountId);
  reportDays(start, end, detail.timezone);
  if (campaignId) oneCampaign(await request(c, `campaigns/${campaignId}`), accountId, campaignId);
  const query = new URLSearchParams({ granularity: 'TOTAL', fields: 'spend,impressions,swipes', start_time: start, end_time: end });
  const rows = snapchatAdsRows(await request(c, `${campaignId ? `campaigns/${campaignId}` : `adaccounts/${accountId}`}/stats?${query}`), 'total_stats', 'total_stat');
  if (rows.length > 1) snapchatAdsFailure();
  const items = rows.map(row => {
    if (row.id !== (campaignId || accountId) || row.type !== (campaignId ? 'CAMPAIGN' : 'AD_ACCOUNT') || row.granularity !== 'TOTAL') snapchatAdsFailure();
    const stats = snapchatAdsObject(row.stats), spend = micros(stats.spend);
    return { accountId, ...(campaignId ? { campaignId } : {}), startTime: start, endTime: end, spend: amount(spend), spendMicros: spend, currency: detail.currency, timezone: detail.timezone, impressions: micros(stats.impressions), swipes: micros(stats.swipes) };
  });
  return { summary: `Snapchat ${campaignId ? 'campaign' : 'account'} totals in ${detail.currency} for the requested time window. Recent metrics may change; empty results and missing metrics do not establish zero spend.`, items };
});
