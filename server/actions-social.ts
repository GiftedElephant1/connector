import { apiJson, apiRequest, bearer, httpsUrl, jsonBody, records, required, string } from './action-http';
import { isObject } from './provider-http';
import { ProviderError, type Credential } from './provider-types';
import type { ActionAdapter, ActionDefinition, ActionField, ActionResult, ActionValues } from './action-types';
import { listLinkedInOrganizations } from './linkedin-organizations';

const field = (name: string, label: string, type: ActionField['type'] = 'text', help?: string, optional = false): ActionField => ({ name, label, type, required: !optional, ...(help ? { help } : {}) });
const select = (name: string, label: string, options: string[], help?: string): ActionField => ({ ...field(name, label, 'select', help), options: options.map((value) => ({ value, label: value })) });
const content = field('text', 'Text', 'textarea');
const numericId = (values: ActionValues, key: string): string => {
  const value = required(values, key);
  if (!/^\d{1,30}$/.test(value)) throw new ProviderError(`${key} must be a numeric platform ID.`);
  return value;
};
const bounded = (values: ActionValues, key: string, max: number): string => {
  const value = required(values, key);
  if (value.length > max) throw new ProviderError(`${key} must be at most ${max} characters.`);
  return value;
};
function failed(provider: string): never { throw new ProviderError(`${provider} did not confirm this action. Check the platform before retrying a write.`, 502); }
function checked(provider: string, body: Record<string, unknown>): Record<string, unknown> {
  if (body.error || (Array.isArray(body.errors) && body.errors.length)) return failed(provider);
  return body;
}
function mustList(provider: string, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return failed(provider);
  return records(value);
}
function resultId(provider: string, value: unknown): string {
  const id = string(value);
  if (!id) return failed(provider);
  return id;
}
function metrics(value: unknown): Record<string, string | number | boolean | null> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === 'number' && Number.isFinite(entry[1])).slice(0, 50)) as Record<string, number>;
}
function action(provider: string, definition: ActionDefinition, execute: ActionAdapter['execute']): ActionAdapter { return { provider, definition, execute }; }
function postJson(credential: Credential, value: unknown): RequestInit {
  const json = jsonBody(value);
  return { method: 'POST', ...json, headers: { ...bearer(credential), ...json.headers } };
}
const publication = (label: string, description: string, fields: ActionField[]): ActionDefinition => ({ id: 'publish', label, description, fields, group: 'publishing', kind: 'write', schedulable: true });

const xActions: ActionAdapter[] = [
  action('x', publication('Publish text post', 'Publish a text post to X. X applies your account’s post length and access-tier limits.', [content]), async (credential, values) => {
    const body = checked('X', await apiJson('X', 'https://api.x.com/2/tweets', postJson(credential, { text: bounded(values, 'text', 25000) })));
    const id = resultId('X', isObject(body.data) ? body.data.id : undefined);
    return { summary: 'Post published on X.', items: [{ id }], link: `https://x.com/i/status/${encodeURIComponent(id)}` };
  }),
  action('x', { id: 'comments', label: 'Read post replies', group: 'inbox', kind: 'read', description: 'Read up to 25 recent replies in a conversation. Recent search covers the provider’s recent window and requires eligible API access.', fields: [field('postId', 'Root conversation / post ID')] }, async (credential, values) => {
    const query = new URLSearchParams({ query: `conversation_id:${numericId(values, 'postId')}`, max_results: '25', 'tweet.fields': 'author_id,created_at,conversation_id' });
    const body = checked('X', await apiJson('X', `https://api.x.com/2/tweets/search/recent?${query}`, { headers: bearer(credential) }));
    const data = body.data ?? (isObject(body.meta) && body.meta.result_count === 0 ? [] : undefined);
    return { summary: 'Recent conversation replies.', items: mustList('X', data).map((item) => ({ id: string(item.id), author: string(item.author_id), text: string(item.text), createdAt: string(item.created_at) })) };
  }),
  action('x', { id: 'reply', label: 'Reply to a post', group: 'inbox', kind: 'write', description: 'Publish a public reply to a specific X post.', fields: [field('postId', 'Post ID to reply to'), content] }, async (credential, values) => {
    const body = checked('X', await apiJson('X', 'https://api.x.com/2/tweets', postJson(credential, { text: bounded(values, 'text', 25000), reply: { in_reply_to_tweet_id: numericId(values, 'postId') } })));
    return { summary: 'Reply published on X.', items: [{ id: resultId('X', isObject(body.data) ? body.data.id : undefined) }] };
  }),
  action('x', { id: 'messages', label: 'Read direct messages', group: 'inbox', kind: 'read', description: 'Read up to 25 recent DM events. Availability and history depend on your X API tier.', fields: [] }, async (credential) => {
    const body = checked('X', await apiJson('X', 'https://api.x.com/2/dm_events?max_results=25&dm_event.fields=created_at,dm_conversation_id,sender_id,text,participant_ids', { headers: bearer(credential) }));
    const data = body.data ?? (isObject(body.meta) && body.meta.result_count === 0 ? [] : undefined);
    return { summary: 'Recent direct-message events.', items: mustList('X', data).map((item) => ({ id: string(item.id), conversationId: string(item.dm_conversation_id), senderId: string(item.sender_id), text: string(item.text), createdAt: string(item.created_at) })) };
  }),
  action('x', { id: 'send-message', label: 'Send or reply to a DM', group: 'inbox', kind: 'write', description: 'Send a one-to-one direct message to the specified X user. The recipient’s messaging permissions apply.', fields: [field('participantId', 'Recipient user ID'), content] }, async (credential, values) => {
    const body = checked('X', await apiJson('X', `https://api.x.com/2/dm_conversations/with/${numericId(values, 'participantId')}/messages`, postJson(credential, { text: bounded(values, 'text', 10000) })));
    if (!isObject(body.data)) return failed('X');
    return { summary: 'Direct message sent on X.', items: [{ id: resultId('X', body.data.dm_event_id), conversationId: string(body.data.dm_conversation_id) }] };
  }),
  action('x', { id: 'analytics', label: 'Post metrics', group: 'analytics', kind: 'read', description: 'Read public engagement, or eligible metrics on your own recent posts. Private metrics require user-context access and the appropriate tier.', fields: [field('postId', 'Post ID'), select('metricAccess', 'Metrics', ['public', 'owned'])] }, async (credential, values) => {
    if (!['public', 'owned'].includes(required(values, 'metricAccess'))) throw new ProviderError('Choose public or owned metrics.');
    const fields = values.metricAccess === 'owned' ? 'public_metrics,non_public_metrics,organic_metrics' : 'public_metrics';
    const body = checked('X', await apiJson('X', `https://api.x.com/2/tweets/${numericId(values, 'postId')}?tweet.fields=${fields}`, { headers: bearer(credential) }));
    if (!isObject(body.data) || !isObject(body.data.public_metrics)) return failed('X');
    return { summary: 'Metrics returned by X.', items: [{ id: resultId('X', body.data.id), ...metrics(body.data.public_metrics), ...metrics(body.data.non_public_metrics), ...Object.fromEntries(Object.entries(metrics(body.data.organic_metrics)).map(([key, value]) => [`organic_${key}`, value])) }] };
  }),
];

function tiktokData(body: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(body.error) || body.error.code !== 'ok' || !isObject(body.data)) return failed('TikTok');
  return body.data;
}
const tiktokActions: ActionAdapter[] = [
  action('tiktok', { id: 'creator-info', label: 'Check publishing options', group: 'publishing', kind: 'read', description: 'Read the creator’s allowed privacy settings and video duration before preparing a Direct Post.', fields: [] }, async (credential) => {
    const data = tiktokData(await apiJson('TikTok', 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', postJson(credential, {})));
    if (!Array.isArray(data.privacy_level_options)) return failed('TikTok');
    return { summary: 'Review these creator settings before submitting a video.', items: [{ creator: string(data.creator_nickname), username: string(data.creator_username), privacyOptions: data.privacy_level_options.filter((item) => typeof item === 'string').join(', '), maxVideoSeconds: typeof data.max_video_post_duration_sec === 'number' ? data.max_video_post_duration_sec : null, commentsDisabled: data.comment_disabled === true, duetDisabled: data.duet_disabled === true, stitchDisabled: data.stitch_disabled === true }] };
  }),
  action('tiktok', publication('Submit video to TikTok', 'Submit a video from a TikTok-verified HTTPS domain. Requires approved Content Posting API access. Run Check publishing options first and check publication status afterward.', [field('videoUrl', 'Video HTTPS URL', 'url'), field('title', 'Caption', 'textarea'), select('privacy', 'Privacy (choose explicitly)', ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']), select('allowComments', 'Allow comments', ['yes', 'no']), select('allowDuet', 'Allow duet', ['yes', 'no']), select('allowStitch', 'Allow stitch', ['yes', 'no']), select('brandOrganic', 'Promotes your own brand', ['yes', 'no']), select('brandContent', 'Paid partnership / branded content', ['yes', 'no']), select('aiGenerated', 'AI-generated content', ['yes', 'no']), select('consent', 'TikTok music and content terms', ['I agree'], 'You confirm ownership/permission and agree to TikTok’s Music Usage Confirmation; branded content must also comply with its Branded Content Policy.')]), async (credential, values) => {
    const videoUrl = httpsUrl(required(values, 'videoUrl'));
    const title = bounded(values, 'title', 2200);
    if (values.consent !== 'I agree') throw new ProviderError('Confirm TikTok music and content terms.');
    for (const key of ['allowComments', 'allowDuet', 'allowStitch', 'brandOrganic', 'brandContent', 'aiGenerated']) {
      if (!['yes', 'no'].includes(required(values, key))) throw new ProviderError(`Choose yes or no for ${key}.`);
    }
    const creator = tiktokData(await apiJson('TikTok', 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', postJson(credential, {})));
    if (!Array.isArray(creator.privacy_level_options) || !creator.privacy_level_options.includes(required(values, 'privacy'))) throw new ProviderError('This creator cannot use that privacy setting. Refresh publishing options and choose an available setting.');
    if (values.brandContent === 'yes' && values.privacy === 'SELF_ONLY') throw new ProviderError('TikTok branded content cannot use SELF_ONLY privacy.');
    const data = tiktokData(await apiJson('TikTok', 'https://open.tiktokapis.com/v2/post/publish/video/init/', postJson(credential, {
      post_info: { title, privacy_level: values.privacy, disable_comment: creator.comment_disabled === true || values.allowComments === 'no', disable_duet: creator.duet_disabled === true || values.allowDuet === 'no', disable_stitch: creator.stitch_disabled === true || values.allowStitch === 'no', brand_organic_toggle: values.brandOrganic === 'yes', brand_content_toggle: values.brandContent === 'yes', is_aigc: values.aiGenerated === 'yes' },
      source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
    })));
    return { summary: 'TikTok accepted the video submission. Check its status before treating it as published.', items: [{ publishId: resultId('TikTok', data.publish_id) }] };
  }),
  action('tiktok', { id: 'publish-status', label: 'Check video publication status', group: 'publishing', kind: 'read', description: 'Check processing, completion or failure of a previously submitted video.', fields: [field('publishId', 'Publish ID')] }, async (credential, values) => {
    const data = tiktokData(await apiJson('TikTok', 'https://open.tiktokapis.com/v2/post/publish/status/fetch/', postJson(credential, { publish_id: bounded(values, 'publishId', 300) })));
    const status = resultId('TikTok', data.status);
    return { summary: `TikTok publication status: ${status}.`, items: [{ status, reason: string(data.fail_reason), publishedIds: Array.isArray(data.publicaly_available_post_id) ? data.publicaly_available_post_id.map((item) => string(item)).join(', ') : '' }] };
  }),
  action('tiktok', { id: 'analytics', label: 'Video metrics', group: 'analytics', kind: 'read', description: 'Read available counts for a video owned by the connected creator using the video.list permission.', fields: [field('videoId', 'Video ID')] }, async (credential, values) => {
    const data = tiktokData(await apiJson('TikTok', 'https://open.tiktokapis.com/v2/video/query/?fields=id,title,view_count,like_count,comment_count,share_count', postJson(credential, { filters: { video_ids: [numericId(values, 'videoId')] } })));
    return { summary: 'Available video metrics.', items: mustList('TikTok', data.videos).map((video) => ({ id: string(video.id), title: string(video.title), ...metrics(video) })) };
  }),
];

function linkedinHeaders(credential: Credential, env: NodeJS.ProcessEnv): Record<string, string> {
  const version = env.LINKEDIN_API_VERSION?.trim() || '202601';
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(version)) throw new ProviderError('Configure a supported LINKEDIN_API_VERSION in YYYYMM format.');
  return { ...bearer(credential), 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' };
}
function postUrn(values: ActionValues): string {
  const urn = required(values, 'postUrn');
  if (!/^urn:li:(ugcPost|share|activity):\d{1,30}$/.test(urn)) throw new ProviderError('Use the LinkedIn post URN returned after publishing.');
  return urn;
}
async function memberUrn(credential: Credential): Promise<string> {
  const user = await apiJson('LinkedIn', 'https://api.linkedin.com/v2/userinfo', { headers: bearer(credential) });
  const sub = string(user.sub);
  if (!/^[\w-]{1,200}$/.test(sub)) return failed('LinkedIn');
  return `urn:li:person:${sub}`;
}
const organizationField = field('organizationUrn', 'LinkedIn company Page URN', 'text', 'Use the exact urn:li:organization:… returned by List LinkedIn company Pages. The authorizing member’s name is not the publishing destination.');
async function selectedOrganization(credential: Credential, values: ActionValues, env: NodeJS.ProcessEnv): Promise<string> {
  const urn = required(values, 'organizationUrn', 'LinkedIn company Page URN');
  if (!/^urn:li:organization:\d{1,30}$/.test(urn)) throw new ProviderError('Select a company Page using its full urn:li:organization:… identifier from List LinkedIn company Pages.');
  const organizations = await listLinkedInOrganizations(credential, env);
  if (!organizations.some(organization => organization.id === urn)) throw new ProviderError('This LinkedIn company Page is not available to the connected member. List company Pages again and select an authorized Page.', 403);
  return urn;
}
const linkedinActions: ActionAdapter[] = [
  action('linkedin', { id: 'list-organizations', label: 'List LinkedIn company Pages', group: 'publishing', kind: 'read', description: 'Fetch company Pages the connected member can manage and publish to. Requires approved company Page permissions in LinkedIn setup, then reconnect. Use an explicit organizationUrn from these results for company actions; personal profile and ad-account names are separate.', fields: [] }, async (credential, _values, env) => {
    const organizations = await listLinkedInOrganizations(credential, env);
    return { summary: `${organizations.length} accessible LinkedIn company Pages. Select the intended organizationUrn explicitly.`, items: organizations.map(organization => ({ organizationUrn: organization.id, name: organization.name, type: organization.type })) };
  }),
  action('linkedin', { id: 'publish-organization', label: 'Publish company Page text post', group: 'publishing', kind: 'write', schedulable: true, description: 'Publish a public text post as the explicitly selected company Page. Requires approved w_organization_social and company Page access. This never publishes to the connected member’s personal profile.', fields: [organizationField, content] }, async (credential, values, env) => {
    const commentary = bounded(values, 'text', 3000);
    const author = await selectedOrganization(credential, values, env);
    const body = { author, commentary, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false };
    const response = await apiRequest('LinkedIn', 'https://api.linkedin.com/rest/posts', { ...postJson(credential, body), headers: { ...linkedinHeaders(credential, env), 'content-type': 'application/json' } });
    if (isObject(response.body)) checked('LinkedIn', response.body);
    const id = resultId('LinkedIn', response.headers.get('x-restli-id') ?? (isObject(response.body) ? response.body.id : undefined));
    return { summary: 'Company Page post published on LinkedIn.', items: [{ id, organizationUrn: author }] };
  }),
  action('linkedin', { id: 'organization-posts', label: 'Read company Page posts', group: 'inbox', kind: 'read', description: 'Read up to 25 recent posts authored by the selected company Page. Requires approved r_organization_social and company Page access.', fields: [organizationField] }, async (credential, values, env) => {
    const author = await selectedOrganization(credential, values, env);
    const query = new URLSearchParams({ q: 'author', author, count: '25', sortBy: 'LAST_MODIFIED' });
    const body = checked('LinkedIn', await apiJson('LinkedIn', `https://api.linkedin.com/rest/posts?${query}`, { headers: { ...linkedinHeaders(credential, env), 'X-RestLi-Method': 'FINDER' } }));
    const posts = mustList('LinkedIn', body.elements).slice(0, 25);
    if (posts.some(post => post.author !== author)) throw new ProviderError('LinkedIn returned a post outside the selected company Page. No posts were returned by Connector.', 502);
    return { summary: 'Recent LinkedIn company Page posts.', items: posts.map(post => ({ postUrn: string(post.id), organizationUrn: author, text: string(post.commentary), createdAt: string(post.createdAt), lastModifiedAt: string(post.lastModifiedAt), status: string(post.lifecycleState) })) };
  }),
  action('linkedin', publication('Publish member text post', 'Publish a public text post on the connected member’s LinkedIn profile. Requires Share on LinkedIn (w_member_social).', [content]), async (credential, values, env) => {
    const commentary = bounded(values, 'text', 3000);
    const author = await memberUrn(credential);
    const body = { author, commentary, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false };
    const response = await apiRequest('LinkedIn', 'https://api.linkedin.com/rest/posts', { ...postJson(credential, body), headers: { ...linkedinHeaders(credential, env), 'content-type': 'application/json' } });
    if (isObject(response.body)) checked('LinkedIn', response.body);
    const id = resultId('LinkedIn', response.headers.get('x-restli-id') ?? (isObject(response.body) ? response.body.id : undefined));
    return { summary: 'Member post published on LinkedIn.', items: [{ id }] };
  }),
  action('linkedin', { id: 'comments', label: 'Read post comments (approved apps)', group: 'inbox', kind: 'read', description: 'Requires LinkedIn’s restricted r_member_social permission. Standard Sign In and Share on LinkedIn applications do not have this read permission.', fields: [field('postUrn', 'Post URN')] }, async (credential, values, env) => {
    if (env.LINKEDIN_ENABLE_MEMBER_READ !== 'true') throw new ProviderError('LinkedIn comment reads require approved r_member_social access. Configure LINKEDIN_ENABLE_MEMBER_READ=true only after approval, then reconnect.');
    const body = checked('LinkedIn', await apiJson('LinkedIn', `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(postUrn(values))}/comments?count=25`, { headers: linkedinHeaders(credential, env) }));
    return { summary: 'LinkedIn post comments.', items: mustList('LinkedIn', body.elements).map((item) => ({ id: string(item.id), commentUrn: string(item.commentUrn), actor: string(item.actor), text: isObject(item.message) ? string(item.message.text) : '' })) };
  }),
  action('linkedin', { id: 'reply', label: 'Comment or reply on a post', group: 'inbox', kind: 'write', description: 'Write as the connected member. Leave parent comment URN empty for a top-level comment; provide it to reply. Requires approved access to the Social Actions API.', fields: [field('postUrn', 'Post URN'), field('parentCommentUrn', 'Parent comment URN', 'text', undefined, true), content] }, async (credential, values, env) => {
    const object = postUrn(values);
    const parent = values.parentCommentUrn?.trim();
    if (parent && !/^urn:li:comment:\(urn:li:(ugcPost|share|activity):\d{1,30},\d{1,30}\)$/.test(parent)) throw new ProviderError('Use a full LinkedIn parent comment URN.');
    const body = { actor: await memberUrn(credential), object, message: { text: bounded(values, 'text', 1250) }, ...(parent ? { parentComment: parent } : {}) };
    const response = await apiRequest('LinkedIn', `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(object)}/comments`, { ...postJson(credential, body), headers: { ...linkedinHeaders(credential, env), 'content-type': 'application/json' } });
    if (isObject(response.body)) checked('LinkedIn', response.body);
    return { summary: 'Comment submitted to LinkedIn.', items: [{ id: resultId('LinkedIn', isObject(response.body) ? response.body.id ?? response.headers.get('x-restli-id') : response.headers.get('x-restli-id')) }] };
  }),
];

function redditHeaders(credential: Credential, env: NodeJS.ProcessEnv): Record<string, string> {
  const userAgent = env.REDDIT_USER_AGENT?.trim();
  if (!userAgent || /[\r\n]/.test(userAgent)) throw new ProviderError('Configure REDDIT_USER_AGENT with an identifying application user agent.');
  return { ...bearer(credential), 'user-agent': userAgent };
}
function redditName(values: ActionValues, key: string, prefix: string): string {
  const value = required(values, key).replace(new RegExp(`^${prefix}_`), '');
  if (!/^[a-z0-9]{1,25}$/i.test(value)) throw new ProviderError(`Enter a valid Reddit ${key}.`);
  return `${prefix}_${value}`;
}
async function redditWrite(credential: Credential, env: NodeJS.ProcessEnv, path: string, values: Record<string, string>): Promise<Record<string, unknown>> {
  const body = await apiJson('Reddit', `https://oauth.reddit.com${path}`, { method: 'POST', headers: { ...redditHeaders(credential, env), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_type: 'json', ...values }) });
  if (!isObject(body.json) || !Array.isArray(body.json.errors) || body.json.errors.length) return failed('Reddit');
  return isObject(body.json.data) ? body.json.data : {};
}
function redditRows(body: unknown): Record<string, unknown>[] {
  if (!isObject(body) || !isObject(body.data) || !Array.isArray(body.data.children)) return failed('Reddit');
  return records(body.data.children).filter((child) => isObject(child.data)).map((child) => child.data as Record<string, unknown>);
}
const redditActions: ActionAdapter[] = [
  action('reddit', publication('Publish Reddit post', 'Submit a text or link post to a subreddit where your account is allowed to post.', [field('subreddit', 'Subreddit (without r/)'), field('title', 'Title'), select('postType', 'Post type', ['text', 'link']), field('text', 'Text (for a text post)', 'textarea', undefined, true), field('url', 'Link (for a link post)', 'url', undefined, true)]), async (credential, values, env) => {
    const subreddit = required(values, 'subreddit');
    if (!/^[\w]{2,50}$/.test(subreddit)) throw new ProviderError('Enter a subreddit name without r/.');
    if (!['text', 'link'].includes(values.postType)) throw new ProviderError('Choose a text or link post.');
    const data = await redditWrite(credential, env, '/api/submit', { sr: subreddit, title: bounded(values, 'title', 300), kind: values.postType === 'text' ? 'self' : 'link', ...(values.postType === 'text' ? { text: bounded(values, 'text', 40000) } : { url: httpsUrl(required(values, 'url')) }) });
    return { summary: 'Post submitted to Reddit. Subreddit moderation can affect visibility.', items: [{ id: resultId('Reddit', data.name ?? data.id) }] };
  }),
  action('reddit', { id: 'comments', label: 'Read post comments', group: 'inbox', kind: 'read', description: 'Read up to 25 top-level comments; Reddit may return fewer or omit collapsed threads.', fields: [field('postId', 'Post ID')] }, async (credential, values, env) => {
    const id = redditName(values, 'postId', 't3').slice(3);
    const response = await apiRequest('Reddit', `https://oauth.reddit.com/comments/${id}?limit=25&depth=1&raw_json=1`, { headers: redditHeaders(credential, env) });
    if (!Array.isArray(response.body) || response.body.length < 2) return failed('Reddit');
    return { summary: 'Top-level Reddit comments.', items: redditRows(response.body[1]).filter((item) => item.body !== undefined).map((item) => ({ id: string(item.name), author: string(item.author), text: string(item.body), score: typeof item.score === 'number' ? item.score : null })) };
  }),
  action('reddit', { id: 'reply', label: 'Reply to a post or comment', group: 'inbox', kind: 'write', description: 'Publish a reply using a t3_ post or t1_ comment fullname.', fields: [field('parentId', 'Parent fullname (t3_… or t1_…)'), content] }, async (credential, values, env) => {
    const parent = required(values, 'parentId');
    if (!/^t[13]_[a-z0-9]{1,25}$/i.test(parent)) throw new ProviderError('Use a t3_ post or t1_ comment fullname.');
    const data = await redditWrite(credential, env, '/api/comment', { thing_id: parent, text: bounded(values, 'text', 10000) });
    const created = records(data.things)[0];
    return { summary: 'Reply submitted to Reddit.', items: [{ id: resultId('Reddit', isObject(created?.data) ? created.data.name : undefined) }] };
  }),
  action('reddit', { id: 'messages', label: 'Read private-message inbox', group: 'inbox', kind: 'read', description: 'Read Reddit legacy private messages and inbox notifications. Reddit Chat is a different service and is not supported here.', fields: [] }, async (credential, _values, env) => {
    const body = await apiJson('Reddit', 'https://oauth.reddit.com/message/inbox?limit=25&raw_json=1', { headers: redditHeaders(credential, env) });
    return { summary: 'Recent Reddit inbox items.', items: redditRows(body).map((item) => ({ id: string(item.name), author: string(item.author), subject: string(item.subject), text: string(item.body), type: item.was_comment === true ? 'comment notification' : 'private message' })) };
  }),
  action('reddit', { id: 'send-message', label: 'Send private message', group: 'inbox', kind: 'write', description: 'Send a legacy Reddit private message to a user who allows messages.', fields: [field('recipient', 'Recipient username (without u/)'), field('subject', 'Subject'), content] }, async (credential, values, env) => {
    const to = required(values, 'recipient');
    if (!/^[\w-]{1,50}$/.test(to)) throw new ProviderError('Enter the recipient username without u/.');
    await redditWrite(credential, env, '/api/compose', { to, subject: bounded(values, 'subject', 100), text: bounded(values, 'text', 10000) });
    return { summary: 'Private message submitted to Reddit.' };
  }),
  action('reddit', { id: 'reply-message', label: 'Reply to private message', group: 'inbox', kind: 'write', description: 'Reply to a legacy private message using its t4_ fullname from the inbox.', fields: [field('messageId', 'Message fullname (t4_…)'), content] }, async (credential, values, env) => {
    await redditWrite(credential, env, '/api/comment', { thing_id: redditName(values, 'messageId', 't4'), text: bounded(values, 'text', 10000) });
    return { summary: 'Private-message reply submitted to Reddit.' };
  }),
  action('reddit', { id: 'analytics', label: 'Post engagement', group: 'analytics', kind: 'read', description: 'Read score, comment count and upvote ratio. These public values are not reach or impression analytics.', fields: [field('postId', 'Post ID')] }, async (credential, values, env) => {
    const body = await apiJson('Reddit', `https://oauth.reddit.com/api/info?id=${redditName(values, 'postId', 't3')}&raw_json=1`, { headers: redditHeaders(credential, env) });
    return { summary: 'Reddit public post engagement.', items: redditRows(body).map((item) => ({ id: string(item.name), title: string(item.title), ...metrics({ score: item.score, comments: item.num_comments, upvoteRatio: item.upvote_ratio }) })) };
  }),
];

function date(values: ActionValues, key: string): string {
  const value = required(values, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new ProviderError(`${key} must use a valid YYYY-MM-DD date.`);
  return value;
}
const pinterestActions: ActionAdapter[] = [
  action('pinterest', { id: 'boards', label: 'List boards', group: 'publishing', kind: 'read', description: 'List up to 25 boards available to this account.', fields: [] }, async (credential) => {
    const body = checked('Pinterest', await apiJson('Pinterest', 'https://api.pinterest.com/v5/boards?page_size=25', { headers: bearer(credential) }));
    return { summary: 'Available Pinterest boards.', items: mustList('Pinterest', body.items).map((item) => ({ id: string(item.id), name: string(item.name), privacy: string(item.privacy) })) };
  }),
  action('pinterest', publication('Publish image Pin', 'Create a new image Pin on your board from an HTTPS image URL. Pinterest fetches the image.', [field('boardId', 'Board ID'), field('imageUrl', 'Image HTTPS URL', 'url'), field('title', 'Title'), field('description', 'Description', 'textarea', undefined, true), field('link', 'Destination HTTPS URL', 'url', undefined, true)]), async (credential, values) => {
    const body = checked('Pinterest', await apiJson('Pinterest', 'https://api.pinterest.com/v5/pins', postJson(credential, { board_id: numericId(values, 'boardId'), title: bounded(values, 'title', 100), ...(values.description?.trim() ? { description: bounded(values, 'description', 800) } : {}), ...(values.link?.trim() ? { link: httpsUrl(values.link.trim()) } : {}), media_source: { source_type: 'image_url', url: httpsUrl(required(values, 'imageUrl')) } })));
    return { summary: 'Image Pin created.', items: [{ id: resultId('Pinterest', body.id) }] };
  }),
  action('pinterest', { id: 'analytics', label: 'Pin analytics', group: 'analytics', kind: 'read', description: 'Read eligible owned Pin metrics for a date range. Pinterest controls metric availability and retention.', fields: [field('pinId', 'Pin ID'), field('startDate', 'Start date (YYYY-MM-DD)'), field('endDate', 'End date (YYYY-MM-DD)')] }, async (credential, values) => {
    const start = date(values, 'startDate'), end = date(values, 'endDate');
    if (start > end) throw new ProviderError('The start date must be on or before the end date.');
    const query = new URLSearchParams({ start_date: start, end_date: end, metric_types: 'IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK' });
    const body = checked('Pinterest', await apiJson('Pinterest', `https://api.pinterest.com/v5/pins/${numericId(values, 'pinId')}/analytics?${query}`, { headers: bearer(credential) }));
    const items = Object.entries(body).filter(([, value]) => isObject(value) && isObject(value.summary_metrics)).slice(0, 25).map(([segment, value]) => ({ segment, ...metrics((value as Record<string, unknown>).summary_metrics) }));
    if (!items.length) return failed('Pinterest');
    return { summary: 'Pinterest Pin analytics by segment.', items };
  }),
];

const siteField = field('siteId', 'WordPress.com site ID');
function wpSite(values: ActionValues): string { return `https://public-api.wordpress.com/rest/v1.1/sites/${numericId(values, 'siteId')}`; }
async function wpWrite(credential: Credential, url: string, values: Record<string, string>): Promise<Record<string, unknown>> {
  return checked('WordPress', await apiJson('WordPress', url, { method: 'POST', headers: { ...bearer(credential), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) }));
}
const wordpressActions: ActionAdapter[] = [
  action('wordpress', publication('Publish WordPress post', 'Publish a post on an authorized WordPress.com or eligible Jetpack-connected site.', [siteField, field('title', 'Title'), field('content', 'Post content (HTML supported)', 'textarea')]), async (credential, values) => {
    const body = await wpWrite(credential, `${wpSite(values)}/posts/new`, { title: bounded(values, 'title', 300), content: bounded(values, 'content', 100000), status: 'publish' });
    return { summary: 'WordPress accepted the post. Check its returned status; site permissions may require editorial review.', items: [{ id: resultId('WordPress', body.ID), status: string(body.status) }] };
  }),
  action('wordpress', { id: 'posts', label: 'Recent site posts', group: 'publishing', kind: 'read', description: 'Read up to 25 posts to find IDs for comment management.', fields: [siteField] }, async (credential, values) => {
    const body = checked('WordPress', await apiJson('WordPress', `${wpSite(values)}/posts/?number=25`, { headers: bearer(credential) }));
    return { summary: 'Recent WordPress posts.', items: mustList('WordPress', body.posts).map((item) => ({ id: string(item.ID), title: string(item.title), status: string(item.status) })) };
  }),
  action('wordpress', { id: 'comments', label: 'Read post comments', group: 'inbox', kind: 'read', description: 'Read up to 25 comments on a post.', fields: [siteField, field('postId', 'Post ID')] }, async (credential, values) => {
    const body = checked('WordPress', await apiJson('WordPress', `${wpSite(values)}/posts/${numericId(values, 'postId')}/replies/?number=25`, { headers: bearer(credential) }));
    return { summary: 'WordPress post comments.', items: mustList('WordPress', body.comments).map((item) => ({ id: string(item.ID), author: isObject(item.author) ? string(item.author.name) : '', text: string(item.content), status: string(item.status) })) };
  }),
  action('wordpress', { id: 'reply', label: 'Reply to a comment', group: 'inbox', kind: 'write', description: 'Reply to an existing comment. Site moderation can hold the reply for approval.', fields: [siteField, field('commentId', 'Parent comment ID'), content] }, async (credential, values) => {
    const body = await wpWrite(credential, `${wpSite(values)}/comments/${numericId(values, 'commentId')}/replies/new`, { content: bounded(values, 'text', 10000) });
    return { summary: 'WordPress accepted the comment reply.', items: [{ id: resultId('WordPress', body.ID), status: string(body.status) }] };
  }),
  action('wordpress', { id: 'analytics', label: 'Site statistics', group: 'analytics', kind: 'read', description: 'Read the statistics summary exposed by WordPress.com. Jetpack Stats access and plan eligibility may apply.', fields: [siteField] }, async (credential, values) => {
    const body = checked('WordPress', await apiJson('WordPress', `${wpSite(values)}/stats`, { headers: bearer(credential) }));
    if (!isObject(body.stats)) return failed('WordPress');
    return { summary: 'WordPress.com site statistics.', items: [{ siteId: numericId(values, 'siteId'), ...metrics(body.stats) }] };
  }),
];

export const socialActions: ActionAdapter[] = [...xActions, ...tiktokActions, ...linkedinActions, ...redditActions, ...pinterestActions, ...wordpressActions];
