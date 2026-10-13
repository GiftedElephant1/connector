import { createHash, createHmac } from 'node:crypto';
import { apiJson, epochSeconds, httpsUrl, numeric, records, required, string } from './action-http';
import { isObject, safeCredential } from './provider-http';
import { ProviderError, type Credential } from './provider-types';
import type { ActionAdapter, ActionField, ActionResult, ActionValues } from './action-types';

type Context = { credential: Credential; env: NodeJS.ProcessEnv };
const textField = (name: string, label: string, help?: string): ActionField => ({ name, label, type: 'text', required: true, ...(help ? { help } : {}) });
const messageField: ActionField = { name: 'message', label: 'Message', type: 'textarea', required: true };
const pageField = textField('pageId', 'Facebook Page ID');
const instagramField = textField('accountId', 'Instagram professional account ID');
const adAccountField = textField('adAccountId', 'Ad account ID', 'Numeric ID, with or without the act_ prefix.');
const dateFields: ActionField[] = [{ name: 'since', label: 'Start date (optional)', type: 'datetime' }, { name: 'until', label: 'End date (optional)', type: 'datetime' }];

function id(values: ActionValues, name: string): string {
  const value = required(values, name);
  if (!/^\d+(?:_\d+)?$/.test(value) || value.length > 100) throw new ProviderError(`${name} must be a Meta numeric ID.`);
  return value;
}
function graphVersion(env: NodeJS.ProcessEnv, threads: boolean): string {
  const value = env[threads ? 'THREADS_API_VERSION' : 'META_API_VERSION']?.trim() || (threads ? 'v1.0' : 'v26.0');
  if (!/^v\d+\.\d+$/.test(value)) throw new ProviderError('The configured Meta API version is invalid.');
  return value;
}
function secret(env: NodeJS.ProcessEnv): string {
  if (!env.META_APP_SECRET?.trim()) throw new ProviderError('Set META_APP_SECRET before using Meta actions.');
  return env.META_APP_SECRET.trim();
}
async function graph(context: Context, path: string, data: Record<string, unknown> = {}, write = false, threads = false): Promise<Record<string, unknown>> {
  const token = safeCredential(context.credential);
  const url = new URL(`https://${threads ? 'graph.threads.com' : 'graph.facebook.com'}/${graphVersion(context.env, threads)}/${path}`);
  if (threads) url.searchParams.set('access_token', token);
  else url.searchParams.set('appsecret_proof', createHmac('sha256', secret(context.env)).update(token).digest('hex'));
  const headers: Record<string, string> = threads ? {} : { authorization: `Bearer ${token}` };
  if (!write) for (const [key, value] of Object.entries(data)) url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  const body = await apiJson(threads ? 'Threads' : 'Meta', url.toString(), write ? {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data),
  } : { headers });
  if (body.error) throw new ProviderError('Meta denied this action. Check permissions and the platform before retrying.', 403);
  return body;
}
function resultId(body: Record<string, unknown>, label: string): string {
  const value = body.id;
  if (typeof value !== 'string' || !/^\d+(?:_\d+)?$/.test(value)) throw new ProviderError(`Meta did not return a valid ${label} ID. Check the platform before retrying.`, 502);
  return value;
}
async function pageContext(context: Context, accountId: string, instagram = false): Promise<{ context: Context; pageId: string }> {
  const body = await graph(context, 'me/accounts', { fields: instagram ? 'id,name,access_token,instagram_business_account{id}' : 'id,name,access_token', limit: 100 });
  const page = records(body.data).find((item) => instagram ? isObject(item.instagram_business_account) && item.instagram_business_account.id === accountId : item.id === accountId);
  if (!page || typeof page.access_token !== 'string' || typeof page.id !== 'string') {
    throw new ProviderError('No accessible Page token was found for this account. Reconnect, grant the Page and required permissions, and check its Instagram linkage.');
  }
  return { pageId: page.id, context: { ...context, credential: { accessToken: page.access_token } } };
}
function dateParams(values: ActionValues): Record<string, number> {
  const since = values.since ? epochSeconds(values.since) : Math.floor(Date.now() / 1000) - 7 * 86400;
  const until = values.until ? epochSeconds(values.until) : Math.floor(Date.now() / 1000);
  if (since >= until) throw new ProviderError('The start date must be before the end date.');
  return { since, until };
}
function insightRows(body: Record<string, unknown>): NonNullable<ActionResult['items']> {
  return records(body.data).flatMap((metric) => {
    const series = records(metric.values);
    if (!series.length && isObject(metric.total_value)) series.push(metric.total_value);
    return series.map((entry) => ({ metric: string(metric.name), period: string(metric.period), date: string(entry.end_time), value: typeof entry.value === 'number' ? entry.value : string(entry.value, 'Detailed breakdown available in platform') }));
  }).slice(0, 100);
}
function adapter(provider: string, definition: ActionAdapter['definition'], execute: (context: Context, values: ActionValues) => Promise<ActionResult>): ActionAdapter {
  return { provider, definition, execute: (credential, values, env) => execute({ credential, env }, values) };
}
async function readMessages(context: Context, values: ActionValues, instagram: boolean): Promise<ActionResult> {
  const selected = await pageContext(context, id(values, instagram ? 'accountId' : 'pageId'), instagram);
  const conversation = required(values, 'conversationId');
  if (!/^[A-Za-z0-9_:=+/-]{1,1000}$/.test(conversation)) throw new ProviderError('Enter a valid conversation ID.');
  const body = await graph(selected.context, `${encodeURIComponent(conversation)}/messages`, { fields: 'id,message,created_time,from{id,name}', limit: 50 });
  return { summary: 'Recent conversation messages.', items: records(body.data).map((item) => ({ messageId: string(item.id), message: string(item.message), created: string(item.created_time), senderId: isObject(item.from) ? string(item.from.id) : '' })) };
}
async function conversations(context: Context, values: ActionValues, instagram: boolean): Promise<ActionResult> {
  const selected = await pageContext(context, id(values, instagram ? 'accountId' : 'pageId'), instagram);
  const body = await graph(selected.context, `${selected.pageId}/conversations`, { platform: instagram ? 'instagram' : 'messenger', fields: 'id,updated_time,participants', limit: 50 });
  return { summary: 'Recent conversations; use a participant ID to reply within Meta’s allowed messaging window.', items: records(body.data).map((item) => ({ conversationId: string(item.id), updated: string(item.updated_time), participants: isObject(item.participants) ? records(item.participants.data).map((person) => `${string(person.name)} (${string(person.id)})`).join(', ') : '' })) };
}
async function replyMessage(context: Context, values: ActionValues, instagram: boolean): Promise<ActionResult> {
  const selected = await pageContext(context, id(values, instagram ? 'accountId' : 'pageId'), instagram);
  const message = required(values, 'message');
  if (message.length > 1000) throw new ProviderError('Keep this message to 1,000 characters or fewer.');
  const body = await graph(selected.context, `${selected.pageId}/messages`, { recipient: { id: id(values, 'recipientId') }, message: { text: message }, messaging_type: 'RESPONSE', ...(instagram ? { platform: 'instagram' } : {}) }, true);
  if (typeof body.message_id !== 'string') throw new ProviderError('Meta did not return a message ID. Check the conversation before retrying.', 502);
  return { summary: `${instagram ? 'Instagram' : 'Messenger'} reply sent.`, items: [{ messageId: body.message_id, recipientId: string(body.recipient_id) }] };
}
async function finishInstagram(context: Context, accountId: string, creationId: string): Promise<ActionResult> {
  let ready = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const status = await graph(context, creationId, { fields: 'status_code' });
    if (status.status_code === 'FINISHED') { ready = true; break; }
    if (status.status_code === 'PUBLISHED') throw new ProviderError(`Instagram container ${creationId} is already published. Check Instagram before creating another post.`);
    if (status.status_code !== 'IN_PROGRESS') throw new ProviderError(`Instagram container ${creationId} is not ready for publication. Check its media requirements before retrying.`);
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new ProviderError(`Instagram is still processing container ${creationId}. Use Publish existing container after processing completes.`);
  const published = await graph(context, `${accountId}/media_publish`, { creation_id: creationId }, true);
  return { summary: 'Instagram image published.', items: [{ mediaId: resultId(published, 'media') }] };
}
async function threadsPublish(context: Context, values: ActionValues, reply: boolean): Promise<ActionResult> {
  const text = required(values, 'text');
  if (text.length > 500) throw new ProviderError('Threads text can contain at most 500 characters.');
  const container = await graph(context, 'me/threads', { media_type: 'TEXT', text, ...(reply ? { reply_to_id: id(values, 'threadId') } : {}) }, true, true);
  const published = await graph(context, 'me/threads_publish', { creation_id: resultId(container, 'container') }, true, true);
  return { summary: reply ? 'Threads reply published.' : 'Threads post published.', items: [{ threadId: resultId(published, 'thread') }] };
}
function adAccount(values: ActionValues): string {
  const raw = required(values, 'adAccountId').replace(/^act_/, '');
  if (!/^\d{1,30}$/.test(raw)) throw new ProviderError('Enter a numeric Meta ad account ID.');
  return `act_${raw}`;
}
function select(values: ActionValues, name: string, allowed: string[], fallback?: string): string {
  const value = values[name]?.trim() || fallback || '';
  if (!allowed.includes(value)) throw new ProviderError(`Select a valid ${name}.`);
  return value;
}

export const metaActions: ActionAdapter[] = [
  adapter('facebook', { id: 'publish-post', label: 'Publish Page post', group: 'publishing', kind: 'write', schedulable: true, description: 'Publish text and an optional link to a Facebook Page.', fields: [pageField, messageField, { name: 'link', label: 'Link (optional)', type: 'url' }] }, async (context, values) => {
    const page = await pageContext(context, id(values, 'pageId'));
    const body = await graph(page.context, `${page.pageId}/feed`, { message: required(values, 'message'), ...(values.link?.trim() ? { link: httpsUrl(values.link) } : {}) }, true);
    return { summary: 'Facebook Page post published.', items: [{ postId: resultId(body, 'post') }] };
  }),
  adapter('facebook', { id: 'list-posts', label: 'Read Page posts', group: 'inbox', kind: 'read', description: 'List recent Page posts and their IDs for comments.', fields: [pageField] }, async (context, values) => {
    const page = await pageContext(context, id(values, 'pageId'));
    const body = await graph(page.context, `${page.pageId}/posts`, { fields: 'id,message,created_time,permalink_url', limit: 25 });
    return { summary: 'Recent Facebook Page posts.', items: records(body.data).map((item) => ({ postId: string(item.id), message: string(item.message), created: string(item.created_time), url: string(item.permalink_url) })) };
  }),
  adapter('facebook', { id: 'list-comments', label: 'Read post comments', group: 'inbox', kind: 'read', description: 'Read recent comments on a Page post.', fields: [pageField, textField('postId', 'Post ID')] }, async (context, values) => {
    const page = await pageContext(context, id(values, 'pageId'));
    const body = await graph(page.context, `${id(values, 'postId')}/comments`, { fields: 'id,message,created_time,from{id,name}', limit: 50 });
    return { summary: 'Recent post comments.', items: records(body.data).map((item) => ({ commentId: string(item.id), message: string(item.message), created: string(item.created_time), author: isObject(item.from) ? string(item.from.name) : '' })) };
  }),
  adapter('facebook', { id: 'reply-comment', label: 'Reply to comment', group: 'inbox', kind: 'write', description: 'Reply to a comment as the selected Page.', fields: [pageField, textField('commentId', 'Comment ID'), messageField] }, async (context, values) => {
    const page = await pageContext(context, id(values, 'pageId'));
    const body = await graph(page.context, `${id(values, 'commentId')}/comments`, { message: required(values, 'message') }, true);
    return { summary: 'Facebook comment reply published.', items: [{ commentId: resultId(body, 'comment') }] };
  }),
  adapter('facebook', { id: 'list-conversations', label: 'Read Messenger conversations', group: 'inbox', kind: 'read', description: 'List Page Messenger conversations and participants.', fields: [pageField] }, (context, values) => conversations(context, values, false)),
  adapter('facebook', { id: 'list-messages', label: 'Read Messenger messages', group: 'inbox', kind: 'read', description: 'Read a conversation’s recent messages.', fields: [pageField, textField('conversationId', 'Conversation ID')] }, (context, values) => readMessages(context, values, false)),
  adapter('facebook', { id: 'reply-message', label: 'Reply in Messenger', group: 'inbox', kind: 'write', description: 'Reply to a person who contacted your Page within Meta’s allowed messaging window. Requires Page messaging access.', fields: [pageField, textField('recipientId', 'Recipient’s Page-scoped ID'), messageField] }, (context, values) => replyMessage(context, values, false)),
  adapter('facebook', { id: 'page-insights', label: 'Read Page analytics', group: 'analytics', kind: 'read', description: 'Read daily Page media views for the selected dates, defaulting to the last seven days.', fields: [pageField, ...dateFields] }, async (context, values) => {
    const page = await pageContext(context, id(values, 'pageId'));
    const body = await graph(page.context, `${page.pageId}/insights`, { metric: 'page_media_view', period: 'day', ...dateParams(values) });
    return { summary: 'Page media views. Meta can omit unavailable dates or metrics.', items: insightRows(body) };
  }),
  adapter('instagram', { id: 'publish-image', label: 'Publish Instagram image', group: 'publishing', kind: 'write', schedulable: true, description: 'Publish one public HTTPS image and a caption. Instagram downloads the image; JPEG and platform image requirements apply.', fields: [instagramField, { name: 'imageUrl', label: 'Public HTTPS image URL', type: 'url', required: true }, { name: 'caption', label: 'Caption', type: 'textarea' }] }, async (context, values) => {
    const accountId = id(values, 'accountId');
    const imageUrl = httpsUrl(required(values, 'imageUrl'));
    if ((values.caption?.length || 0) > 2200) throw new ProviderError('Instagram captions can contain at most 2,200 characters.');
    const page = await pageContext(context, accountId, true);
    const body = await graph(page.context, `${accountId}/media`, { image_url: imageUrl, caption: values.caption || '' }, true);
    return finishInstagram(page.context, accountId, resultId(body, 'container'));
  }),
  adapter('instagram', { id: 'publish-container', label: 'Publish existing container', group: 'publishing', kind: 'write', description: 'Finish publishing a previously created image container after Instagram processing completes.', fields: [instagramField, textField('creationId', 'Container ID')] }, async (context, values) => {
    const accountId = id(values, 'accountId');
    const page = await pageContext(context, accountId, true);
    return finishInstagram(page.context, accountId, id(values, 'creationId'));
  }),
  adapter('instagram', { id: 'list-media', label: 'Read Instagram posts', group: 'inbox', kind: 'read', description: 'List recent Instagram media and their IDs for comments.', fields: [instagramField] }, async (context, values) => {
    const accountId = id(values, 'accountId');
    const page = await pageContext(context, accountId, true);
    const body = await graph(page.context, `${accountId}/media`, { fields: 'id,caption,media_type,permalink,timestamp', limit: 25 });
    return { summary: 'Recent Instagram posts.', items: records(body.data).map((item) => ({ mediaId: string(item.id), caption: string(item.caption), mediaType: string(item.media_type), url: string(item.permalink), date: string(item.timestamp) })) };
  }),
  adapter('instagram', { id: 'list-comments', label: 'Read Instagram comments', group: 'inbox', kind: 'read', description: 'List recent comments on a professional account’s media.', fields: [instagramField, textField('mediaId', 'Media ID')] }, async (context, values) => {
    const page = await pageContext(context, id(values, 'accountId'), true);
    const body = await graph(page.context, `${id(values, 'mediaId')}/comments`, { fields: 'id,text,username,timestamp', limit: 50 });
    return { summary: 'Recent Instagram comments.', items: records(body.data).map((item) => ({ commentId: string(item.id), text: string(item.text), username: string(item.username), date: string(item.timestamp) })) };
  }),
  adapter('instagram', { id: 'reply-comment', label: 'Reply to Instagram comment', group: 'inbox', kind: 'write', description: 'Reply to a comment on your professional account’s media.', fields: [instagramField, textField('commentId', 'Comment ID'), messageField] }, async (context, values) => {
    const page = await pageContext(context, id(values, 'accountId'), true);
    const body = await graph(page.context, `${id(values, 'commentId')}/replies`, { message: required(values, 'message') }, true);
    return { summary: 'Instagram comment reply published.', items: [{ commentId: resultId(body, 'comment') }] };
  }),
  adapter('instagram', { id: 'list-conversations', label: 'Read Instagram conversations', group: 'inbox', kind: 'read', description: 'Read professional-account conversations through its linked Facebook Page. Requires Instagram messaging approval.', fields: [instagramField] }, (context, values) => conversations(context, values, true)),
  adapter('instagram', { id: 'list-messages', label: 'Read Instagram messages', group: 'inbox', kind: 'read', description: 'Read a conversation through the linked Page’s authorized Instagram messaging access.', fields: [instagramField, textField('conversationId', 'Conversation ID')] }, (context, values) => readMessages(context, values, true)),
  adapter('instagram', { id: 'reply-message', label: 'Reply in Instagram', group: 'inbox', kind: 'write', description: 'Reply to a person who contacted the professional account within Meta’s allowed messaging window. Requires approved Instagram messaging access.', fields: [instagramField, textField('recipientId', 'Recipient’s Instagram-scoped ID'), messageField] }, (context, values) => replyMessage(context, values, true)),
  adapter('instagram', { id: 'account-insights', label: 'Read Instagram analytics', group: 'analytics', kind: 'read', description: 'Read account reach, views, or interactions for a date range; defaults to seven days.', fields: [instagramField, { name: 'metric', label: 'Metric', type: 'select', default: 'reach', options: ['reach', 'views', 'total_interactions'].map((value) => ({ value, label: value.replaceAll('_', ' ') })) }, ...dateFields] }, async (context, values) => {
    const accountId = id(values, 'accountId');
    const page = await pageContext(context, accountId, true);
    const body = await graph(page.context, `${accountId}/insights`, { metric: select(values, 'metric', ['reach', 'views', 'total_interactions'], 'reach'), period: 'day', metric_type: 'total_value', ...dateParams(values) });
    return { summary: 'Instagram account analytics. Availability depends on account history and selected metric.', items: insightRows(body) };
  }),
  adapter('threads', { id: 'publish-post', label: 'Publish Threads post', group: 'publishing', kind: 'write', schedulable: true, description: 'Publish a text post of up to 500 characters.', fields: [{ name: 'text', label: 'Post text', type: 'textarea', required: true }] }, (context, values) => threadsPublish(context, values, false)),
  adapter('threads', { id: 'list-posts', label: 'Read Threads posts', group: 'inbox', kind: 'read', description: 'List recent posts and their IDs.', fields: [] }, async (context) => {
    const body = await graph(context, 'me/threads', { fields: 'id,text,permalink,timestamp', limit: 25 }, false, true);
    return { summary: 'Recent Threads posts.', items: records(body.data).map((item) => ({ threadId: string(item.id), text: string(item.text), url: string(item.permalink), date: string(item.timestamp) })) };
  }),
  adapter('threads', { id: 'list-replies', label: 'Read Threads replies', group: 'inbox', kind: 'read', description: 'Read replies to one of your Threads posts.', fields: [textField('threadId', 'Thread ID')] }, async (context, values) => {
    const body = await graph(context, `${id(values, 'threadId')}/replies`, { fields: 'id,text,username,timestamp', limit: 50 }, false, true);
    return { summary: 'Recent Threads replies.', items: records(body.data).map((item) => ({ threadId: string(item.id), text: string(item.text), username: string(item.username), date: string(item.timestamp) })) };
  }),
  adapter('threads', { id: 'reply-post', label: 'Reply on Threads', group: 'inbox', kind: 'write', description: 'Publish a text reply to a thread.', fields: [textField('threadId', 'Thread ID to reply to'), { name: 'text', label: 'Reply', type: 'textarea', required: true }] }, (context, values) => threadsPublish(context, values, true)),
  adapter('threads', { id: 'post-insights', label: 'Read Threads analytics', group: 'analytics', kind: 'read', description: 'Read views, likes, replies, reposts and quotes for one of your posts.', fields: [textField('threadId', 'Thread ID')] }, async (context, values) => {
    const body = await graph(context, `${id(values, 'threadId')}/insights`, { metric: 'views,likes,replies,reposts,quotes' }, false, true);
    return { summary: 'Threads post analytics.', items: insightRows(body) };
  }),
  adapter('meta-business', { id: 'create-campaign', label: 'Create paused campaign', group: 'advertising', kind: 'write', description: 'Create a PAUSED campaign. Add an ad set and ad, then explicitly activate each level to deliver ads.', fields: [adAccountField, textField('name', 'Campaign name'), { name: 'objective', label: 'Objective', type: 'select', default: 'OUTCOME_TRAFFIC', options: ['OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_APP_PROMOTION'].map((value) => ({ value, label: value.replace('OUTCOME_', '').toLowerCase() })) }, { name: 'specialCategories', label: 'Special ad categories', type: 'text', help: 'Comma-separated: HOUSING, EMPLOYMENT, CREDIT, FINANCIAL_PRODUCTS_SERVICES, ISSUES_ELECTIONS_POLITICS, ONLINE_GAMBLING_AND_GAMING. Leave empty only if none apply.' }] }, async (context, values) => {
    const special = (values.specialCategories || '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
    if (special.some((value) => !['HOUSING', 'EMPLOYMENT', 'CREDIT', 'FINANCIAL_PRODUCTS_SERVICES', 'ISSUES_ELECTIONS_POLITICS', 'ONLINE_GAMBLING_AND_GAMING'].includes(value))) throw new ProviderError('Enter valid special ad categories or leave the field empty if none apply.');
    const body = await graph(context, `${adAccount(values)}/campaigns`, { name: required(values, 'name'), objective: select(values, 'objective', ['OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_APP_PROMOTION'], 'OUTCOME_TRAFFIC'), special_ad_categories: special, status: 'PAUSED', is_adset_budget_sharing_enabled: false }, true);
    return { summary: 'Paused campaign created. A campaign alone cannot deliver ads; configure its ad set and creative.', items: [{ campaignId: resultId(body, 'campaign'), status: 'PAUSED' }] };
  }),
  adapter('meta-business', { id: 'create-traffic-adset', label: 'Create paused traffic ad set', group: 'advertising', kind: 'write', description: 'Create a website traffic ad set with a daily budget and country targeting for a non-special-category traffic campaign. It remains PAUSED.', fields: [adAccountField, textField('campaignId', 'Traffic campaign ID'), textField('name', 'Ad set name'), { name: 'dailyBudget', label: 'Daily budget in account minor units', type: 'number', required: true, help: 'For a USD account, 1000 means $10/day. Meta minimum budgets apply.' }, textField('country', 'Country code', 'Two-letter country code, such as US. Default adult audience, automatic placements.')] }, async (context, values) => {
    const campaignId = id(values, 'campaignId');
    const dailyBudget = numeric(values, 'dailyBudget', 1);
    if (!Number.isSafeInteger(dailyBudget)) throw new ProviderError('Daily budget must be an integer in account minor units.');
    const country = required(values, 'country').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new ProviderError('Enter a two-letter country code.');
    const campaign = await graph(context, campaignId, { fields: 'id,objective,special_ad_categories' });
    if (campaign.objective !== 'OUTCOME_TRAFFIC' || !Array.isArray(campaign.special_ad_categories) || campaign.special_ad_categories.some((category) => category !== 'NONE')) throw new ProviderError('This simple ad set builder supports traffic campaigns without special ad categories. Configure other campaign types in Meta Ads Manager.');
    const body = await graph(context, `${adAccount(values)}/adsets`, { name: required(values, 'name'), campaign_id: campaignId, daily_budget: dailyBudget, billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', destination_type: 'WEBSITE', targeting: { geo_locations: { countries: [country] }, age_min: 18, age_max: 65 }, status: 'PAUSED' }, true);
    return { summary: 'Paused traffic ad set created with the specified daily budget.', items: [{ adSetId: resultId(body, 'ad set'), dailyBudget, status: 'PAUSED' }] };
  }),
  adapter('meta-business', { id: 'create-post-creative', label: 'Create creative from Page post', group: 'advertising', kind: 'write', description: 'Create an ad creative from an existing published Facebook Page post. Use a link post for website traffic.', fields: [adAccountField, textField('name', 'Creative name'), textField('postId', 'Published Page post ID', 'Use the full PageID_PostID returned by Facebook.')] }, async (context, values) => {
    const postId = id(values, 'postId');
    if (!/^\d+_\d+$/.test(postId)) throw new ProviderError('Use a full published PageID_PostID.');
    const body = await graph(context, `${adAccount(values)}/adcreatives`, { name: required(values, 'name'), object_story_id: postId }, true);
    return { summary: 'Ad creative created from the existing Page post.', items: [{ creativeId: resultId(body, 'creative') }] };
  }),
  adapter('meta-business', { id: 'create-ad', label: 'Create paused ad', group: 'advertising', kind: 'write', description: 'Attach a creative to an existing ad set. The new ad remains PAUSED until you activate it.', fields: [adAccountField, textField('name', 'Ad name'), textField('adSetId', 'Ad set ID'), textField('creativeId', 'Creative ID')] }, async (context, values) => {
    const body = await graph(context, `${adAccount(values)}/ads`, { name: required(values, 'name'), adset_id: id(values, 'adSetId'), creative: { creative_id: id(values, 'creativeId') }, status: 'PAUSED' }, true);
    return { summary: 'Paused ad created. Activate the campaign, ad set, and ad when ready to spend.', items: [{ adId: resultId(body, 'ad'), status: 'PAUSED' }] };
  }),
  adapter('meta-business', { id: 'set-status', label: 'Activate or pause ads', group: 'advertising', kind: 'write', description: 'Set a campaign, ad set, or ad ACTIVE or PAUSED. Activation can spend the configured budget once all levels are active and approved.', fields: [textField('objectId', 'Campaign, ad set, or ad ID'), { name: 'status', label: 'Status', type: 'select', required: true, default: 'PAUSED', options: [{ value: 'PAUSED', label: 'Pause' }, { value: 'ACTIVE', label: 'Activate (can spend)' }] }] }, async (context, values) => {
    const objectId = id(values, 'objectId');
    const status = select(values, 'status', ['PAUSED', 'ACTIVE']);
    const body = await graph(context, objectId, { status }, true);
    if (body.success !== true && body.id !== objectId) throw new ProviderError('Meta did not confirm the status change. Check Ads Manager before retrying.', 502);
    return { summary: status === 'ACTIVE' ? 'Status set to ACTIVE. Eligible ads can now spend their configured budgets.' : 'Status set to PAUSED.', items: [{ objectId, status }] };
  }),
  adapter('meta-business', { id: 'spend-insights', label: 'Read ad spend and results', group: 'analytics', kind: 'read', description: 'Read a sample of daily campaign spend, impressions, clicks and cost per click.', fields: [adAccountField, { name: 'datePreset', label: 'Date range', type: 'select', default: 'last_7d', options: [{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'last_7d', label: 'Last 7 days' }, { value: 'last_30d', label: 'Last 30 days' }] }] }, async (context, values) => {
    const body = await graph(context, `${adAccount(values)}/insights`, { fields: 'date_start,date_stop,account_currency,campaign_id,campaign_name,spend,impressions,clicks,cpc,ctr', level: 'campaign', date_preset: select(values, 'datePreset', ['today', 'yesterday', 'last_7d', 'last_30d'], 'last_7d'), time_increment: 1, limit: 100 });
    return { summary: 'Up to 100 daily campaign rows. Spend is in the ad account currency.', items: records(body.data).map((item) => ({ date: string(item.date_start), campaignId: string(item.campaign_id), campaign: string(item.campaign_name), currency: string(item.account_currency), spend: string(item.spend), impressions: string(item.impressions), clicks: string(item.clicks), cpc: string(item.cpc), ctr: string(item.ctr) })) };
  }),
  adapter('meta-business', { id: 'upload-conversion', label: 'Upload website conversion', group: 'advertising', kind: 'write', description: 'Send one consented website conversion to a Meta Pixel/dataset with a stable event ID for deduplication. Email is SHA-256 hashed before transmission.', fields: [textField('pixelId', 'Pixel / dataset ID'), textField('eventName', 'Event name', 'For example Purchase, Lead, or CompleteRegistration.'), { name: 'eventTime', label: 'When the event occurred', type: 'datetime', required: true }, textField('eventId', 'Unique event ID', 'Reuse this ID for the same real-world event to allow deduplication.'), { name: 'sourceUrl', label: 'Website event URL', type: 'url', required: true }, textField('email', 'Customer email or SHA-256 email hash'), { name: 'consent', label: 'Permission to send this customer data', type: 'select', required: true, default: 'no', options: [{ value: 'no', label: 'Not confirmed' }, { value: 'yes', label: 'I have the required permission / consent' }] }, { name: 'value', label: 'Conversion value (optional)', type: 'number' }, { name: 'currency', label: 'Currency for conversion value', type: 'text', default: 'USD' }, { name: 'testEventCode', label: 'Meta test event code (optional)', type: 'text', help: 'Use an Events Manager test code to validate delivery before production events.' }] }, async (context, values) => {
    if (values.consent !== 'yes') throw new ProviderError('Confirm you have the required permission or consent before uploading customer data.');
    const eventTime = epochSeconds(required(values, 'eventTime'));
    const now = Math.floor(Date.now() / 1000);
    if (eventTime < now - 7 * 86400 || eventTime > now + 300) throw new ProviderError('Meta website events must be within the last seven days and cannot be in the future.');
    const eventName = required(values, 'eventName');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(eventName)) throw new ProviderError('Enter a valid conversion event name.');
    const email = required(values, 'email').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ProviderError('Enter an email address or its 64-character SHA-256 hash.');
    const emailHash = /^[a-f0-9]{64}$/.test(email) ? email : createHash('sha256').update(email).digest('hex');
    const event: Record<string, unknown> = { event_name: eventName, event_time: eventTime, event_id: required(values, 'eventId'), action_source: 'website', event_source_url: httpsUrl(required(values, 'sourceUrl')), user_data: { em: [emailHash] } };
    if (values.value?.trim()) {
      const currency = required(values, 'currency').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new ProviderError('Use a three-letter currency code.');
      event.custom_data = { value: numeric(values, 'value'), currency };
    }
    const body = await graph(context, `${id(values, 'pixelId')}/events`, { data: [event], ...(values.testEventCode?.trim() ? { test_event_code: values.testEventCode.trim() } : {}) }, true);
    if (typeof body.events_received !== 'number') throw new ProviderError('Meta did not confirm receipt. Check Events Manager before retrying with the same event ID.', 502);
    return { summary: `${body.events_received} conversion event received by Meta. Receipt does not guarantee attribution.`, items: [{ eventId: required(values, 'eventId'), eventsReceived: body.events_received, testEvent: Boolean(values.testEventCode?.trim()) }] };
  }),
];
