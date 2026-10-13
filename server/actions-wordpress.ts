import { jsonBody, required } from './action-http';
import type { ActionAdapter, ActionDefinition, ActionField, ActionResult, ActionValues } from './action-types';
import { isObject } from './provider-http';
import { ProviderError, type Credential } from './provider-types';
import { normalizeWordPressSite, wordpressJson } from './wordpress-http';

type ContentType = 'post' | 'page';
type ContentItem = Record<string, string | number | boolean | null>;
const draftStatuses = ['draft', 'pending', 'private'];
const editStatuses = [...draftStatuses, 'publish'];
const readStatuses = [...editStatuses, 'future', 'trash', 'auto-draft'];
const field = (name: string, label: string, type: ActionField['type'] = 'text', required = false, help?: string): ActionField => ({ name, label, type, required, ...(help ? { help } : {}) });
const select = (name: string, label: string, choices: string[], defaultValue?: string): ActionField => ({
  ...field(name, label, 'select'), options: choices.map(value => ({ value, label: value })), ...(defaultValue ? { default: defaultValue } : {}),
});

function failure(): never {
  throw new ProviderError('WordPress returned an unexpected content response. Check the website before retrying a write.', 502);
}
function id(values: ActionValues, key: string, zeroAllowed = false): string {
  const value = required(values, key);
  if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (zeroAllowed ? 0 : 1)) {
    throw new ProviderError(`${key} must be a ${zeroAllowed ? 'non-negative' : 'positive'} whole-number WordPress ID.`);
  }
  return String(Number(value));
}
function text(values: ActionValues, key: string): string {
  const value = required(values, key);
  if (value.length > 50_000) throw new ProviderError(`${key} must be at most 50,000 characters.`);
  return value;
}
function status(values: ActionValues, allowed: string[], fallback?: string): string | undefined {
  const value = values.status?.trim() || fallback;
  if (value && !allowed.includes(value)) throw new ProviderError('Choose a supported WordPress content status.');
  return value;
}
function contentText(value: unknown, rawRequired = false): string {
  if (!isObject(value)) return failure();
  if (typeof value.raw === 'string') return value.raw;
  if (!rawRequired && typeof value.rendered === 'string') return value.rendered;
  return failure();
}
function item(value: unknown, type: ContentType, includeContent = false): ContentItem {
  if (!isObject(value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1 || value.type !== type || typeof value.status !== 'string' || !readStatuses.includes(value.status)) return failure();
  return {
    id: String(value.id), type, status: value.status, title: contentText(value.title, includeContent),
    ...(typeof value.slug === 'string' ? { slug: value.slug } : {}),
    ...(typeof value.link === 'string' ? { url: value.link } : {}),
    ...(typeof value.modified_gmt === 'string' ? { modifiedGmt: value.modified_gmt } : {}),
    ...(type === 'page' && Number.isSafeInteger(value.parent) ? { parentId: Number(value.parent) } : {}),
    ...(includeContent ? { content: contentText(value.content, true), ...(type === 'post' ? { excerpt: contentText(value.excerpt, true) } : {}) } : {}),
  };
}
function safeLink(credential: Credential, content: ContentItem): string | undefined {
  if (typeof content.url !== 'string') return undefined;
  try {
    const link = new URL(content.url), site = new URL(normalizeWordPressSite(credential.fields?.siteUrl ?? ''));
    return link.protocol === 'https:' && !link.username && !link.password && link.origin === site.origin ? link.toString() : undefined;
  } catch { return undefined; }
}
function writeResult(credential: Credential, body: unknown, type: ContentType, expectedId?: string): ActionResult {
  const content = item(body, type);
  if (expectedId && content.id !== expectedId) return failure();
  const link = safeLink(credential, content);
  return { summary: `WordPress saved the ${type}. Returned status: ${content.status}.`, items: [content], ...(link ? { link } : {}) };
}
function editFields(type: ContentType, creating: boolean): ActionField[] {
  return [
    field('title', 'Title', 'text', creating, creating ? undefined : 'Leave blank to keep the existing title.'),
    field('content', 'Content (HTML or WordPress block markup)', 'textarea', creating, creating ? undefined : 'Read the current content first. A supplied value replaces all content; blank keeps it unchanged.'),
    ...(type === 'post' ? [field('excerpt', 'Excerpt', 'textarea', false, 'Optional. Leave blank to keep the existing excerpt when editing.')] : []),
    field('slug', 'URL slug', 'text', false, 'Optional. WordPress normalizes the slug.'),
    ...(type === 'page' ? [field('parentId', 'Parent page ID', 'text', false, 'Optional. Use 0 for a top-level page.')] : []),
  ];
}
function payload(values: ActionValues, type: ContentType, creating: boolean): Record<string, string | number> {
  const output: Record<string, string | number> = {};
  for (const key of ['title', 'content', ...(type === 'post' ? ['excerpt'] : []), 'slug']) {
    if ((creating && ['title', 'content'].includes(key)) || values[key]?.trim()) output[key] = text(values, key);
  }
  if (type === 'page' && values.parentId?.trim()) output.parent = Number(id(values, 'parentId', true));
  return output;
}

/** Separate provider IDs preserve existing WordPress.com credentials and scheduled actions. */
export function createWordpressActions(request: typeof wordpressJson = wordpressJson): ActionAdapter[] {
  const action = (definition: ActionDefinition, execute: ActionAdapter['execute']): ActionAdapter => ({ provider: 'wordpress-self-hosted', definition, execute });
  return (['post', 'page'] as const).flatMap((type) => {
    const plural = `${type}s`;
    const endpoint = `/wp/v2/${plural}`;
    const idField = `${type}Id`;
    const base = { group: 'publishing' as const };
    return [
      action({ ...base, id: plural, label: `List ${plural}`, kind: 'read', description: `Read up to 25 ${plural} per result page, including drafts your WordPress user may access. Increase the result page to continue.`, fields: [select('status', 'Status', ['any', ...editStatuses, 'future'], 'any'), { ...field('page', 'Result page', 'number'), default: '1' }] }, async (credential, values) => {
        const selected = status(values, ['any', ...editStatuses, 'future'], 'any')!;
        const page = values.page?.trim() || '1';
        if (!/^[1-9]\d{0,5}$/.test(page)) throw new ProviderError('Result page must be a positive whole number up to 999999.');
        const query = new URLSearchParams({ context: 'edit', per_page: '25', page, status: selected });
        const body = await request(credential, `${endpoint}?${query}`);
        if (!Array.isArray(body) || body.length > 25) return failure();
        return { summary: `WordPress ${plural}, result page ${page}. Request the next result page if this one contains 25 items.`, items: body.map(value => item(value, type)) };
      }),
      action({ ...base, id: `read-${type}`, label: `Read ${type} for editing`, kind: 'read', description: `Read the complete editable source of one ${type}, including HTML or WordPress block markup. Preserve markup you do not intend to change.`, fields: [field(idField, `${type === 'post' ? 'Post' : 'Page'} ID`, 'text', true)] }, async (credential, values) => {
        const contentId = id(values, idField);
        const body = await request(credential, `${endpoint}/${contentId}?context=edit`);
        const content = item(body, type, true);
        if (content.id !== contentId) return failure();
        return { summary: `Editable WordPress ${type} source.`, items: [content] };
      }),
      action({ ...base, id: `create-${type}`, label: `Create ${type} draft`, kind: 'write', description: `Create a ${type} as a draft by default. Pending review and private statuses are also available; choose Publish ${type} for public publication.`, fields: [...editFields(type, true), select('status', 'Status', draftStatuses, 'draft')] }, async (credential, values) => {
        const body = { ...payload(values, type, true), status: status(values, draftStatuses, 'draft')! };
        return writeResult(credential, await request(credential, endpoint, { method: 'POST', ...jsonBody(body) }), type);
      }),
      action({ ...base, id: type === 'post' ? 'publish' : 'publish-page', label: `Publish ${type}`, kind: 'write', schedulable: true, description: `Create and publish a new public WordPress ${type}. Can be scheduled by Connector; keep Connector running until the scheduled time. Requires WordPress publish permission.`, fields: editFields(type, true) }, async (credential, values) => {
        const body = { ...payload(values, type, true), status: 'publish' };
        return writeResult(credential, await request(credential, endpoint, { method: 'POST', ...jsonBody(body) }), type);
      }),
      action({ ...base, id: `update-${type}`, label: `Edit existing ${type}`, kind: 'write', description: `Update only the supplied fields of an existing ${type}. Blank fields and an omitted status remain unchanged. Setting status to publish makes this content public. Read the source first when changing content.`, fields: [field(idField, `${type === 'post' ? 'Post' : 'Page'} ID`, 'text', true), ...editFields(type, false), select('status', 'New status (optional)', editStatuses)] }, async (credential, values) => {
        const contentId = id(values, idField);
        const body = payload(values, type, false);
        const selected = status(values, editStatuses);
        if (selected) body.status = selected;
        if (!Object.keys(body).length) throw new ProviderError('Supply at least one field to update. Blank fields keep their existing values.');
        return writeResult(credential, await request(credential, `${endpoint}/${contentId}`, { method: 'POST', ...jsonBody(body) }), type, contentId);
      }),
    ];
  });
}

export const wordpressActions = createWordpressActions();
