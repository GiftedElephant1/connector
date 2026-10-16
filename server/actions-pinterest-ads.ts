import { apiRequest, bearer, required, string } from './action-http';
import type { ActionAdapter, ActionField, ActionValues } from './action-types';
import { isObject } from './provider-http';
import { ProviderError, type Credential } from './provider-types';

// Contracts: https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml
// Campaign POST/PATCH bodies are arrays; successful HTTP responses can still
// contain per-item exceptions. Monetary fields are account-currency microunits.
export const pinterestAdsActions: ActionAdapter[] = [];
const field = (name: string, label: string, help?: string, type: ActionField['type'] = 'text'): ActionField => ({ name, label, type, required: true, ...(help ? { help } : {}) });
const account = field('accountId', 'Pinterest advertising account ID');
const campaign = field('campaignId', 'Pinterest campaign ID');
const budget = field('dailyBudget', 'Daily campaign budget', 'In the advertising account currency. Up to six decimal places; Pinterest minimums apply.', 'number');
const currency = field('currency', 'Account currency', 'Three-letter currency code, for example USD. Must match the selected advertising account.');
const state: ActionField = { name: 'status', label: 'Campaign status', type: 'select', required: true, options: [{ value: 'ACTIVE', label: 'Launch / enable (may start spending)' }, { value: 'PAUSED', label: 'Pause' }] };
const accountPath = (id: string) => `ad_accounts/${id}`;

function add(id: string, label: string, kind: 'read' | 'write', fields: ActionField[], description: string, execute: ActionAdapter['execute']) {
  pinterestAdsActions.push({ provider: 'pinterest-ads', definition: { id, label, kind, fields, group: 'advertising', description }, execute });
}
function numericId(values: ActionValues, name: string): string {
  const value = required(values, name);
  if (!/^\d{1,18}$/.test(value)) throw new ProviderError(`${name} must be a numeric Pinterest ID of at most 18 digits.`);
  return value;
}
function failure(message: string): never { throw new ProviderError(`Pinterest Ads ${message} Check Pinterest before retrying a write.`, 502); }
function checkErrors(body: Record<string, unknown>) {
  for (const name of ['error', 'errors', 'exception', 'exceptions']) {
    const value = body[name];
    if (value !== undefined && value !== null && value !== false && (!Array.isArray(value) || value.length > 0)) failure('reported a failed or partially failed operation.');
  }
}
async function request(c: Credential, path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await apiRequest('Pinterest Ads', `https://api.pinterest.com/v5/${path}`, {
    method, headers: { ...bearer(c), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (isObject(response.body)) checkErrors(response.body);
  return response.body;
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) failure('returned an unexpected response.');
  checkErrors(value);
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isObject)) failure('returned an unexpected list.');
  return value;
}
function confirmedCampaign(value: unknown, accountId: string, expectedId?: string) {
  const data = object(value);
  if (typeof data.id !== 'string' || !/^\d{1,18}$/.test(data.id) || (expectedId !== undefined && data.id !== expectedId)) failure('did not confirm the requested campaign.');
  if (data.ad_account_id !== undefined && data.ad_account_id !== accountId) failure('returned a campaign from a different advertising account.');
  return data;
}
function confirmWrite(value: unknown, accountId: string, expected: Record<string, unknown>) {
  const body = object(value);
  const items = records(body.items);
  if (items.length !== 1) failure('did not confirm the single campaign operation.');
  const item = object(items[0]);
  const data = confirmedCampaign(item.data, accountId, typeof expected.id === 'string' ? expected.id : undefined);
  for (const [key, wanted] of Object.entries(expected)) {
    if (data[key] !== wanted) failure('did not confirm the requested campaign change.');
  }
  return data;
}
async function accountCurrency(c: Credential, accountId: string): Promise<string> {
  const data = object(await request(c, accountPath(accountId)));
  if (data.id !== accountId || typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency)) failure('did not confirm the selected account and its currency.');
  return data.currency;
}
function money(values: ActionValues) {
  const amount = required(values, 'dailyBudget');
  if (!/^\d{1,10}(?:\.\d{1,6})?$/.test(amount)) throw new ProviderError('Daily budget must be a positive decimal with at most six decimal places.');
  const [whole, fraction = ''] = amount.split('.');
  const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (micro <= 0n || micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProviderError('Daily budget must resolve to a positive safe integer number of micro-currency units.');
  const code = required(values, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new ProviderError('Currency must be a three-letter code matching the advertising account.');
  return { micro: Number(micro), currency: code };
}
async function checkCurrency(c: Credential, accountId: string, expected: string) {
  const actual = await accountCurrency(c, accountId);
  if (actual !== expected) throw new ProviderError(`Budget currency must match the selected Pinterest advertising account (${actual}). No campaign change was sent.`);
}
function microValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d{1,30}$/.test(value)) return value;
  failure('returned an invalid micro-currency amount.');
}
function decimal(micro: string | null): string | null {
  if (micro === null) return null;
  const number = BigInt(micro), negative = number < 0n, absolute = negative ? -number : number;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}
function calendar(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function dates(values: ActionValues) {
  const start = required(values, 'startDate'), end = required(values, 'endDate');
  if (!calendar(start) || !calendar(end) || end < start || Date.parse(end) - Date.parse(start) >= 31 * 86_400_000) throw new ProviderError('Use valid, ordered YYYY-MM-DD dates covering at most 31 calendar days.');
  return { start, end };
}

add('list-campaigns', 'List campaigns', 'read', [account], 'Read the first 100 Pinterest advertising campaigns. This is a preview, not a complete account inventory.', async (c, v) => {
  const accountId = numericId(v, 'accountId');
  const body = object(await request(c, `${accountPath(accountId)}/campaigns?page_size=100`));
  const rows = records(body.items);
  return {
    summary: `Pinterest campaigns (first ${Math.min(rows.length, 100)} returned; budgets are account-currency microunits).${body.bookmark || rows.length > 100 ? ' More campaigns exist beyond this preview.' : ''}`,
    items: rows.slice(0, 100).map(row => {
      const data = confirmedCampaign(row, accountId);
      return { id: string(data.id), accountId, name: string(data.name), status: string(data.status), objective: string(data.objective_type), dailyBudgetMicros: microValue(data.daily_spend_cap), lifetimeBudgetMicros: microValue(data.lifetime_spend_cap) };
    }),
  };
});

add('create-campaign', 'Create paused consideration campaign', 'write', [account, field('name', 'Campaign name'), budget, currency], 'Create one paused Pinterest consideration campaign with a daily campaign budget. Ad groups, targeting, eligible Pins, approved ads, and billing must be configured before delivery.', async (c, v) => {
  const accountId = numericId(v, 'accountId'), name = required(v, 'name'), amount = money(v);
  if (name.length > 255) throw new ProviderError('Campaign name must be at most 255 characters.');
  await checkCurrency(c, accountId, amount.currency);
  const data = confirmWrite(await request(c, `${accountPath(accountId)}/campaigns`, 'POST', [{
    ad_account_id: accountId, name, objective_type: 'CONSIDERATION', status: 'PAUSED', daily_spend_cap: amount.micro,
    is_campaign_budget_optimization: true, is_flexible_daily_budgets: false, is_performance_plus: false,
  }]), accountId, { status: 'PAUSED', daily_spend_cap: amount.micro });
  return { summary: 'Paused Pinterest campaign created. Configure its ad groups, targeting and approved ads before enabling it.', items: [{ id: string(data.id), accountId, status: 'PAUSED', dailyBudget: decimal(String(amount.micro)), dailyBudgetMicros: String(amount.micro), currency: amount.currency }] };
});

add('set-campaign-status', 'Launch or pause campaign', 'write', [account, campaign, state], 'Enable or pause an existing Pinterest campaign. Enabling it can start spending when its ad groups, ads and billing are eligible.', async (c, v) => {
  const accountId = numericId(v, 'accountId'), campaignId = numericId(v, 'campaignId'), status = required(v, 'status');
  if (status !== 'ACTIVE' && status !== 'PAUSED') throw new ProviderError('Choose ACTIVE or PAUSED.');
  confirmWrite(await request(c, `${accountPath(accountId)}/campaigns`, 'PATCH', [{ ad_account_id: accountId, id: campaignId, status }]), accountId, { id: campaignId, status });
  return { summary: 'Pinterest confirmed the campaign status change.', items: [{ id: campaignId, accountId, status }] };
});

add('set-campaign-budget', 'Change daily campaign budget', 'write', [account, campaign, budget, currency], 'Change an existing daily campaign budget. An active campaign may spend more immediately. This preserves status and budget mode; lifetime budgets and ad-group budgets must be managed in Pinterest.', async (c, v) => {
  const accountId = numericId(v, 'accountId'), campaignId = numericId(v, 'campaignId'), amount = money(v);
  await checkCurrency(c, accountId, amount.currency);
  const existing = confirmedCampaign(await request(c, `${accountPath(accountId)}/campaigns/${campaignId}`), accountId, campaignId);
  const currentDaily = microValue(existing.daily_spend_cap), currentLifetime = microValue(existing.lifetime_spend_cap);
  if (existing.is_campaign_budget_optimization !== true || currentDaily === null || BigInt(currentDaily) <= 0n || (currentLifetime !== null && BigInt(currentLifetime) !== 0n)) throw new ProviderError('This action supports existing daily campaign budgets only. Manage lifetime budgets or ad-group budgets in Pinterest; no budget change was sent.');
  confirmWrite(await request(c, `${accountPath(accountId)}/campaigns`, 'PATCH', [{ ad_account_id: accountId, id: campaignId, daily_spend_cap: amount.micro }]), accountId, { id: campaignId, daily_spend_cap: amount.micro });
  return { summary: 'Pinterest confirmed the daily campaign budget change. Campaign status and budget mode were not changed.', items: [{ id: campaignId, accountId, dailyBudget: decimal(String(amount.micro)), dailyBudgetMicros: String(amount.micro), currency: amount.currency }] };
});

add('read-spend', 'Read advertising spend', 'read', [account, field('startDate', 'Start date (YYYY-MM-DD)'), field('endDate', 'End date (YYYY-MM-DD)', 'Inclusive UTC dates; at most 31 days per request. Pinterest allows the recent 90-day reporting window.'), { ...field('campaignIds', 'Campaign IDs separated by commas', 'Optional: up to 20 campaign IDs. Leave blank for daily advertising account totals.'), required: false }], 'Read daily Pinterest spend, impressions and outbound clicks in the account currency. Optionally restrict to selected campaigns. At most 100 rows are returned; missing data is not treated as zero spend.', async (c, v) => {
  const accountId = numericId(v, 'accountId'), range = dates(v);
  const ids = v.campaignIds?.trim() ? v.campaignIds.split(',').map(id => id.trim()) : [];
  if (ids.length > 20 || ids.some(id => !/^\d{1,18}$/.test(id))) throw new ProviderError('Provide up to 20 numeric campaign IDs separated by commas.');
  const selected = [...new Set(ids)];
  const code = await accountCurrency(c, accountId);
  const query = new URLSearchParams({ start_date: range.start, end_date: range.end, granularity: 'DAY', columns: `${selected.length ? 'CAMPAIGN_ID' : 'AD_ACCOUNT_ID'},SPEND_IN_MICRO_DOLLAR,PAID_IMPRESSION,OUTBOUND_CLICK_1` });
  // OpenAPI form arrays use repeated keys for campaign_ids (explode defaults
  // true); columns explicitly uses explode=false and remains comma-separated.
  for (const id of selected) query.append('campaign_ids', id);
  const rows = records(await request(c, `${accountPath(accountId)}/${selected.length ? 'campaigns/' : ''}analytics?${query}`));
  const items = rows.slice(0, 100).map(row => {
    checkErrors(row);
    if (selected.length ? typeof row.CAMPAIGN_ID !== 'string' || !selected.includes(row.CAMPAIGN_ID) : row.AD_ACCOUNT_ID !== accountId) failure('returned reporting data for an unexpected account or campaign.');
    if (typeof row.DATE !== 'string' || !calendar(row.DATE) || row.DATE < range.start || row.DATE > range.end) failure('returned reporting data for an unexpected date.');
    const micro = microValue(row.SPEND_IN_MICRO_DOLLAR);
    return { accountId, ...(selected.length ? { campaignId: string(row.CAMPAIGN_ID) } : {}), date: row.DATE, spend: decimal(micro), spendMicros: micro, currency: code, impressions: row.PAID_IMPRESSION == null ? null : string(row.PAID_IMPRESSION), outboundClicks: row.OUTBOUND_CLICK_1 == null ? null : string(row.OUTBOUND_CLICK_1) };
  });
  return {
    summary: `Pinterest daily ${selected.length ? 'campaign' : 'account'} spend in ${code} for UTC dates (first ${items.length} returned rows). ${rows.length > 100 ? 'More rows exist; this preview is not a complete range total. Use fewer campaign IDs or a shorter date range. ' : ''}MICRO_DOLLAR is a Pinterest field name: amounts use the selected account currency. Empty results and missing metrics do not establish zero spend.`,
    items,
  };
});
