import { apiJson, required, string } from './action-http.ts';
import { isObject } from './provider-http.ts';
import { ProviderError, type Credential } from './provider-types.ts';
import { mailchimpConnection } from './providers-mailchimp.ts';
import type { ActionAdapter, ActionField, ActionResult, ActionValues } from './action-types.ts';

const campaignField: ActionField = { name: 'campaignId', label: 'Campaign ID', type: 'text', required: true, help: 'Use the campaign ID returned by Create campaign or List campaigns.' };
const audienceField: ActionField = { name: 'audienceId', label: 'Audience ID', type: 'text', required: true, help: 'Use the audience ID from List audiences. New campaigns target all subscribed contacts in this audience.' };
const paginationFields: ActionField[] = [
  { name: 'limit', label: 'Results per page', type: 'number', default: '50', help: '1–100 results.' },
  { name: 'offset', label: 'Results to skip', type: 'number', default: '0', help: 'Use the next offset returned by the preceding page.' },
];
const campaignFields = 'id,type,status,settings.title,settings.subject_line,settings.from_name,settings.reply_to,recipients.list_id,recipients.list_name,recipients.recipient_count,emails_sent,send_time';

function id(values: ActionValues, key: string, label: string): string {
  const value = required(values, key, label);
  if (!/^[A-Za-z0-9]{1,64}$/.test(value)) throw new ProviderError(`${label} must be a Mailchimp identifier containing only letters and numbers.`);
  return value;
}
function bounded(values: ActionValues, key: string, label: string, limit: number): string {
  const value = required(values, key, label);
  if (value.length > limit || /[\r\n\u0000]/.test(value)) throw new ProviderError(`${label} must be a single line of at most ${limit} characters.`);
  return value;
}
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function object(value: unknown): Record<string, unknown> { return isObject(value) ? value : {}; }
function pagination(values: ActionValues) {
  const limit = values.limit?.trim() || '50';
  const offset = values.offset?.trim() || '0';
  if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100
    || !/^\d{1,7}$/.test(offset) || Number(offset) > 1_000_000) {
    throw new ProviderError('Use a whole-number limit from 1 to 100 and an offset from 0 to 1,000,000.');
  }
  return { limit: Number(limit), offset: Number(offset) };
}
async function request(credential: Credential, path: string, params: Record<string, string> = {}, method?: string, payload?: Record<string, unknown>) {
  const { origin, headers } = mailchimpConnection(credential);
  const url = new URL(`${origin}${path}`);
  url.search = new URLSearchParams(params).toString();
  return apiJson('Mailchimp', url.toString(), {
    headers: { ...headers, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(method ? { method } : {}), ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
}
function campaignRow(body: Record<string, unknown>): NonNullable<ActionResult['items']>[number] {
  const settings = object(body.settings);
  const recipients = object(body.recipients);
  return {
    campaignId: string(body.id), type: string(body.type), status: string(body.status),
    title: string(settings.title), subject: string(settings.subject_line), fromName: string(settings.from_name), replyTo: string(settings.reply_to),
    audienceId: string(recipients.list_id), audienceName: string(recipients.list_name), recipientCount: number(recipients.recipient_count),
    emailsSent: number(body.emails_sent), sendTime: string(body.send_time),
  };
}
async function readCampaign(credential: Credential, campaignId: string) {
  const body = await request(credential, `/campaigns/${campaignId}`, { fields: campaignFields });
  if (body.id !== campaignId || typeof body.status !== 'string' || typeof body.type !== 'string') {
    throw new ProviderError('Mailchimp returned an invalid campaign.', 502);
  }
  return body;
}
function requireDraft(body: Record<string, unknown>): void {
  if (body.type !== 'regular' || body.status !== 'save') {
    throw new ProviderError('Choose a regular email campaign that is still a draft. Scheduled, sending, and sent campaigns cannot be changed or sent by this action.');
  }
}
function page(body: Record<string, unknown>, key: string, limit: number, offset: number, map: (row: Record<string, unknown>) => NonNullable<ActionResult['items']>[number]): ActionResult {
  const rows = body[key];
  const total = body.total_items;
  if (!Array.isArray(rows) || rows.length > limit || !rows.every(isObject)
    || !Number.isSafeInteger(total) || Number(total) < 0 || Number(total) < offset + rows.length && rows.length > 0
    || rows.length === 0 && Number(total) > offset) {
    throw new ProviderError('Mailchimp returned an invalid or inconsistent result page.', 502);
  }
  const more = offset + rows.length < Number(total);
  return {
    summary: `Mailchimp ${key === 'lists' ? 'audiences' : 'campaigns'}: ${rows.length} of ${total}, starting at offset ${offset}.${more ? ` Request offset ${offset + rows.length} for more.` : ''}`,
    items: [{ rowType: 'pagination', returned: rows.length, total: Number(total), hasMore: more, nextOffset: more ? offset + rows.length : null }, ...rows.map(map)],
  };
}

export const mailchimpActions: ActionAdapter[] = [
  {
    provider: 'mailchimp',
    definition: { id: 'list-audiences', label: 'List audiences', group: 'analytics', kind: 'read', description: 'Read audience IDs, names, and subscribed contact counts. Does not read individual subscriber email addresses.', fields: paginationFields },
    execute: async (credential, values) => {
      const { limit, offset } = pagination(values);
      const body = await request(credential, '/lists', { count: String(limit), offset: String(offset), fields: 'lists.id,lists.name,lists.stats.member_count,total_items' });
      return page(body, 'lists', limit, offset, (row) => ({ audienceId: string(row.id), name: string(row.name), subscribedContacts: number(object(row.stats).member_count) }));
    },
  },
  {
    provider: 'mailchimp',
    definition: { id: 'list-campaigns', label: 'List email campaigns', group: 'analytics', kind: 'read', description: 'Read regular email campaigns, including draft status, audience, and subject. Results are paginated.', fields: paginationFields },
    execute: async (credential, values) => {
      const { limit, offset } = pagination(values);
      const body = await request(credential, '/campaigns', { type: 'regular', count: String(limit), offset: String(offset), sort_field: 'create_time', sort_dir: 'DESC', fields: `${campaignFields.split(',').map((field) => `campaigns.${field}`).join(',')},total_items` });
      return page(body, 'campaigns', limit, offset, campaignRow);
    },
  },
  {
    provider: 'mailchimp',
    definition: { id: 'get-campaign', label: 'Read campaign', group: 'analytics', kind: 'read', description: 'Read campaign status, subject, sender, and its currently selected audience before sending.', fields: [campaignField] },
    execute: async (credential, values) => ({ summary: 'Mailchimp campaign details.', items: [campaignRow(await readCampaign(credential, id(values, 'campaignId', 'Campaign ID')))] }),
  },
  {
    provider: 'mailchimp',
    definition: { id: 'create-campaign', label: 'Create email campaign draft', group: 'publishing', kind: 'write', description: 'Create a regular email campaign draft targeting all subscribed contacts in the chosen audience. This action does not send email. Set its HTML content, review it, then use Send campaign separately.', fields: [
      audienceField, { name: 'title', label: 'Internal campaign title', type: 'text', required: true, help: 'Up to 100 characters.' },
      { name: 'subject', label: 'Email subject', type: 'text', required: true, help: 'Up to 150 characters.' },
      { name: 'fromName', label: 'Sender name', type: 'text', required: true, help: 'Up to 100 characters.' },
      { name: 'replyTo', label: 'Reply-to email', type: 'text', required: true, help: 'Use an email address on a sender domain verified in Mailchimp.' },
    ] },
    execute: async (credential, values) => {
      const audienceId = id(values, 'audienceId', 'Audience ID');
      const title = bounded(values, 'title', 'Campaign title', 100);
      const subject = bounded(values, 'subject', 'Email subject', 150);
      const fromName = bounded(values, 'fromName', 'Sender name', 100);
      const replyTo = bounded(values, 'replyTo', 'Reply-to email', 254);
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(replyTo)) throw new ProviderError('Enter a valid reply-to email address.');
      const body = await request(credential, '/campaigns', {}, 'POST', { type: 'regular', recipients: { list_id: audienceId }, settings: { title, subject_line: subject, from_name: fromName, reply_to: replyTo } });
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(body.id) || body.type !== 'regular' || body.status !== 'save') {
        throw new ProviderError('Mailchimp did not return the expected campaign draft. Check your campaigns before retrying.', 502);
      }
      return { summary: 'Mailchimp campaign draft created. No email was sent. Set its HTML content before sending.', items: [campaignRow(body)] };
    },
  },
  {
    provider: 'mailchimp',
    definition: { id: 'set-campaign-content', label: 'Set draft email content', group: 'publishing', kind: 'write', description: 'Replace the HTML content of a regular campaign draft. Does not send email. Include your required Mailchimp unsubscribe and mailing-address merge tags.', fields: [campaignField, { name: 'html', label: 'Email HTML', type: 'textarea', required: true, help: 'Up to 50,000 characters. Include *|UNSUB|* and your mailing-address footer, for example *|HTML:LIST_ADDRESS_HTML|*.' }] },
    execute: async (credential, values) => {
      const campaignId = id(values, 'campaignId', 'Campaign ID');
      const html = required(values, 'html', 'Email HTML');
      if (html.length > 50_000 || html.includes('\u0000')) throw new ProviderError('Email HTML must contain at most 50,000 characters and no null characters.');
      requireDraft(await readCampaign(credential, campaignId));
      await request(credential, `/campaigns/${campaignId}/content`, {}, 'PUT', { html });
      return { summary: 'Mailchimp draft content updated. No email was sent.', items: [{ campaignId }] };
    },
  },
  {
    provider: 'mailchimp',
    definition: { id: 'send-campaign', label: 'Send email campaign now', group: 'publishing', kind: 'write', description: 'Immediately send a regular campaign draft to its configured recipients in the specified audience. Mailchimp enforces sender verification, recipient eligibility, and plan limits. Read and review the campaign first. This action sends real email and may use paid plan allowances.', fields: [campaignField, { ...audienceField, help: 'Must match this campaign’s currently configured audience. Review the campaign and its recipients in Mailchimp before confirming.' }] },
    execute: async (credential, values) => {
      const campaignId = id(values, 'campaignId', 'Campaign ID');
      const audienceId = id(values, 'audienceId', 'Audience ID');
      const campaign = await readCampaign(credential, campaignId);
      requireDraft(campaign);
      if (object(campaign.recipients).list_id !== audienceId) throw new ProviderError('The campaign audience does not match the audience you selected. Read the campaign and verify its recipients before sending.');
      await request(credential, `/campaigns/${campaignId}/actions/send`, {}, 'POST');
      return { summary: 'Mailchimp accepted the campaign send request. Delivery is not confirmed; read the campaign and report to check progress.', items: [{ campaignId, audienceId }] };
    },
  },
  {
    provider: 'mailchimp',
    definition: { id: 'get-campaign-report', label: 'Read campaign report', group: 'analytics', kind: 'read', description: 'Read aggregate delivery, open, click, bounce, and unsubscribe counts for a sent campaign. Reports may take time to appear.', fields: [campaignField] },
    execute: async (credential, values) => {
      const campaignId = id(values, 'campaignId', 'Campaign ID');
      const body = await request(credential, `/reports/${campaignId}`, { fields: 'id,campaign_title,subject_line,emails_sent,send_time,unsubscribed,abuse_reports,bounces.hard_bounces,bounces.soft_bounces,opens.unique_opens,opens.open_rate,clicks.unique_subscriber_clicks,clicks.click_rate' });
      if (body.id !== campaignId) throw new ProviderError('Mailchimp returned an invalid campaign report.', 502);
      return { summary: 'Mailchimp aggregate campaign report. Opens and clicks reflect Mailchimp tracking and may include privacy-related measurement effects.', items: [{ campaignId, title: string(body.campaign_title), subject: string(body.subject_line), emailsSent: number(body.emails_sent), sendTime: string(body.send_time), unsubscribed: number(body.unsubscribed), abuseReports: number(body.abuse_reports), hardBounces: number(object(body.bounces).hard_bounces), softBounces: number(object(body.bounces).soft_bounces), uniqueOpens: number(object(body.opens).unique_opens), openRate: number(object(body.opens).open_rate), uniqueClickers: number(object(body.clicks).unique_subscriber_clicks), clickRate: number(object(body.clicks).click_rate) }] };
    },
  },
];
