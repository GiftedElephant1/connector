import { createCipheriv, randomBytes } from 'node:crypto';
import { apiRequest, bearer, httpsUrl, required, string } from './action-http';
import type { ActionAdapter, ActionField, ActionValues } from './action-types';
import { isObject } from './provider-http';
import { ProviderError, type Credential } from './provider-types';
import { snapchatApi, snapchatProfiles, snapchatSuccess, snapchatUuid } from './providers-snapchat';

// Official media/upload, Stories and Spotlight contracts:
// https://developers.snap.com/marketing-api/Public-Profile-API/ProfileAssetManagement
export const snapchatActions: ActionAdapter[] = [];
const maxMediaBytes = 20 * 1024 * 1024;
const field = (name: string, label: string, help?: string): ActionField => ({ name, label, type: 'text', required: true, ...(help ? { help } : {}) });
const profile = field('profileId', 'Snapchat Public Profile ID');
const cursor: ActionField = { ...field('cursor', 'Next page cursor', 'Optional nextCursor returned by a previous listing. Do not supply a URL.'), required: false, maxLength: 4096 };
const media: ActionField = {
  name: 'media', label: 'Image or MP4 video', type: 'file', required: true, maxLength: 28_000_000,
  help: 'JPEG/PNG for Stories or MP4 for Stories/Spotlight, up to 20 MiB. For API tools pass a data:image/jpeg;base64,..., data:image/png;base64,... or data:video/mp4;base64,... data URL. Snapchat validates video duration/resolution: Story 5–60 seconds, Spotlight 6–60 seconds, at least 540×960.',
};
const contentName = { ...field('name', 'Content name', 'A private upload label, up to 128 characters; this is not a caption.'), maxLength: 128 };
const link: ActionField = { ...field('link', 'Attached HTTPS link', 'Optional website link attached to the published content.'), required: false, type: 'url', maxLength: 2048 };

function add(id: string, label: string, kind: 'read' | 'write', fields: ActionField[], description: string, execute: ActionAdapter['execute'], schedulable = false) {
  snapchatActions.push({ provider: 'snapchat', definition: { id, label, kind, fields, group: 'publishing', description, ...(schedulable ? { schedulable: true } : {}) }, execute });
}
async function request(credential: Credential, path: string, method = 'GET', body?: unknown) {
  const result = await apiRequest('Snapchat', `${snapchatApi}${path}`, {
    method, headers: { ...bearer(credential), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return snapchatSuccess(result.body);
}
function query(values: ActionValues) {
  const result = new URLSearchParams({ limit: '100' });
  if (values.cursor) {
    if (values.cursor.length > 4096 || /[\r\n\0]/.test(values.cursor)) throw new ProviderError('The Snapchat page cursor is invalid.');
    result.set('cursor', values.cursor);
  }
  return result;
}
function paging(body: Record<string, unknown>) {
  const next = isObject(body.paging) ? body.paging.next_page_id : undefined;
  return typeof next === 'string' && next.length <= 4096 ? next : '';
}
function rows(value: unknown, key: string, expectedProfile: string) {
  if (!Array.isArray(value) || !value.every(isObject)) throw new ProviderError('Snapchat returned an unexpected content list.', 502);
  return value.slice(0, 100).map(row => {
    const item = row[key];
    if (row.sub_request_status !== 'SUCCESS' || !isObject(item) || item.profile_id !== expectedProfile || typeof item.id !== 'string') {
      throw new ProviderError('Snapchat did not confirm the requested profile content.', 502);
    }
    return { id: string(item.id), profileId: expectedProfile, createdAt: string(item.created_at), status: string(item.status), caption: string(item.caption), title: string(item.title), type: key };
  });
}

function mediaInput(values: ActionValues, spotlight: boolean) {
  const value = values.media || '';
  if (value.length > 28_000_000) throw new ProviderError('Snapchat media is limited to 20 MiB.', 413);
  const match = /^data:(image\/(?:jpeg|png)|video\/mp4);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new ProviderError('Use a JPEG/PNG image or MP4 video data URL with canonical base64.');
  if (spotlight && match[1] !== 'video/mp4') throw new ProviderError('Spotlight requires an MP4 video; images can be posted as Stories.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxMediaBytes) throw new ProviderError('Snapchat media is limited to a non-empty file of at most 20 MiB.', 413);
  if (bytes.toString('base64') !== match[2]) throw new ProviderError('The media must use canonical, padded base64 without whitespace.');
  const validHeader = match[1] === 'image/png' ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : match[1] === 'image/jpeg' ? bytes.length >= 4 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      : bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (!validHeader) throw new ProviderError('The file header does not match the selected JPEG, PNG, or MP4 media type.');
  const name = required(values, 'name');
  if (name.length > 128 || /[\r\n\0]/.test(name)) throw new ProviderError('Content name must be one line of at most 128 characters.');
  return { bytes, name, type: match[1] === 'video/mp4' ? 'VIDEO' : 'IMAGE' };
}
function uploadPath(value: unknown, profileId: string, mediaId: string): string {
  // Returned locations are untrusted. Bind both identifiers and allow only
  // the official upload path, optionally prefixed by a two-letter region.
  const expected = new RegExp(`^/(?:[a-z]{2}/)?v1/public_profiles/${profileId}/media/${mediaId}/multipart-upload$`);
  if (typeof value !== 'string' || !expected.test(value)) throw new ProviderError('Snapchat returned an unexpected media upload destination. No media bytes were sent.', 502);
  return value;
}
async function multipart(credential: Credential, path: string, form: FormData) {
  snapchatSuccess((await apiRequest('Snapchat', `${snapchatApi}${path}`, { method: 'POST', headers: bearer(credential), body: form })).body);
}
async function upload(credential: Credential, profileId: string, input: ReturnType<typeof mediaInput>) {
  const key = randomBytes(32), iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(input.bytes), cipher.final()]);
  const created = await request(credential, `/v1/public_profiles/${profileId}/media`, 'POST', {
    type: input.type, name: input.name, key: key.toString('base64'), iv: iv.toString('base64'),
  });
  const mediaId = snapchatUuid(created.media_id, 'Returned Snapchat media ID');
  const addPath = uploadPath(created.add_path, profileId, mediaId), finalizePath = uploadPath(created.finalize_path, profileId, mediaId);
  // 20 MiB + padding fits one documented 32 MiB part. No remote media is fetched.
  const add = new FormData();
  add.set('action', 'ADD'); add.set('part_number', '1');
  add.set('file', new Blob([encrypted], { type: 'application/octet-stream' }), 'media.enc');
  await multipart(credential, addPath, add);
  const finalize = new FormData(); finalize.set('action', 'FINALIZE');
  await multipart(credential, finalizePath, finalize);
  return mediaId;
}
function attachment(values: ActionValues): Record<string, string> {
  if (!values.link?.trim()) return {};
  if (values.link.length > 2048) throw new ProviderError('The attached link must be at most 2,048 characters.');
  return { link: httpsUrl(values.link) };
}

add('list-profiles', 'List organization Public Profiles', 'read', [field('organizationId', 'Snapchat organization ID'), cursor], 'List up to 100 Public Profiles accessible in an explicit Snapchat organization. Use nextCursor for further pages.', async (credential, values) => {
  const organization = snapchatUuid(required(values, 'organizationId'), 'Snapchat organization ID');
  const body = await request(credential, `/v1/organizations/${organization}/public_profiles?${query(values)}`);
  const resources = snapchatProfiles(body.public_profiles), next = paging(body);
  return { summary: `Snapchat Public Profiles (${resources.length} on this page).${next ? ' More profiles are available.' : ''}`, items: [...resources, ...(next ? [{ type: 'pagination', nextCursor: next }] : [])] };
});
for (const [action, key, label] of [['list-stories', 'story', 'Stories'], ['list-spotlights', 'spotlight', 'Spotlights']] as const) {
  add(action, `List ${label}`, 'read', [profile, cursor], `Read up to 100 ${label} for a Public Profile. Use nextCursor for further pages.`, async (credential, values) => {
    const profileId = snapchatUuid(required(values, 'profileId'), 'Public Profile ID');
    const plural = key === 'story' ? 'stories' : 'spotlights';
    const body = await request(credential, `/v1/public_profiles/${profileId}/${plural}?${query(values)}`);
    const items = rows(body[plural], key, profileId), next = paging(body);
    return { summary: `Snapchat ${label} (${items.length} on this page).${next ? ' More content is available.' : ''}`, items: [...items, ...(next ? [{ type: 'pagination', nextCursor: next }] : [])] };
  });
}

add('publish-story', 'Publish Public Profile Story', 'write', [profile, contentName, media, link], 'Encrypt and upload one JPEG/PNG or MP4 file, then submit it to the selected Public Profile Story. Stories use Snapchat’s default 24-hour visibility. Video: 5–60 seconds and at least 540×960. Snapchat validates the media and controls final visibility.', async (credential, values) => {
  const profileId = snapchatUuid(required(values, 'profileId'), 'Public Profile ID'), input = mediaInput(values, false), optional = attachment(values);
  const mediaId = await upload(credential, profileId, input);
  const body = await request(credential, `/v1/public_profiles/${profileId}/stories`, 'POST', { media_id: mediaId, ...optional });
  return { summary: 'Snapchat accepted the Story publication request. Check the Public Profile or list Stories to confirm its visibility before submitting again.', items: [{ profileId, mediaId, requestId: string(body.request_id), status: 'accepted' }] };
}, true);

add('publish-spotlight', 'Publish Spotlight video', 'write', [profile, contentName, { ...media, label: 'MP4 video' }, { ...field('description', 'Spotlight caption', 'Optional caption and hashtags, up to 160 characters.'), required: false, type: 'textarea', maxLength: 160 }, { ...field('locale', 'Locale', 'Language and country, for example en_US.'), default: 'en_US' }, link], 'Encrypt and upload one MP4, then submit it to Spotlight. Video: 6–60 seconds and at least 540×960. Snapchat processes and moderates publication; an accepted request does not guarantee public distribution.', async (credential, values) => {
  const profileId = snapchatUuid(required(values, 'profileId'), 'Public Profile ID'), input = mediaInput(values, true), optional = attachment(values);
  const description = values.description || '', locale = required(values, 'locale');
  if (description.length > 160) throw new ProviderError('Spotlight captions must be at most 160 characters.');
  if (!/^[a-z]{2}_[A-Z]{2}$/.test(locale)) throw new ProviderError('Use a language_country locale such as en_US.');
  const mediaId = await upload(credential, profileId, input);
  const body = await request(credential, `/v1/public_profiles/${profileId}/spotlights`, 'POST', { media_id: mediaId, locale, ...(description ? { description } : {}), ...optional });
  if (typeof body.spotlight_id !== 'string' || !/^[A-Za-z0-9_-]{1,300}$/.test(body.spotlight_id)) throw new ProviderError('Snapchat accepted the request but did not return a usable Spotlight ID. Check Snapchat before submitting again.', 502);
  return { summary: 'Snapchat accepted the Spotlight publication request. Check the Public Profile or list Spotlights for processing and visibility before submitting again.', items: [{ id: body.spotlight_id, profileId, mediaId, status: 'accepted' }] };
}, true);
