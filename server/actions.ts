import type { ActionAdapter, ActionValues } from './action-types';
import { ProviderError } from './provider-types';
import { googleActions } from './actions-google';
import { metaActions } from './actions-meta';
import { discordActions } from './actions-discord';
import { socialActions } from './actions-social';
import { adsActions } from './actions-ads';
import { whatsappActions } from './actions-whatsapp';
import { wordpressActions } from './actions-wordpress';
import { mailchimpActions } from './actions-mailchimp';
import { obsidianActions } from './actions-obsidian';
import { pinterestAdsActions } from './actions-pinterest-ads';

const actions: ActionAdapter[] = [...googleActions, ...metaActions, ...discordActions, ...socialActions, ...adsActions, ...pinterestAdsActions, ...whatsappActions, ...wordpressActions, ...mailchimpActions, ...obsidianActions];
const registry = new Map(actions.map(action => [`${action.provider}:${action.definition.id}`, action]));
if (registry.size !== actions.length) throw new Error('Action identifiers must be unique per provider.');
export function listActions(provider: string) { return actions.filter(action => action.provider === provider).map(action => action.definition); }
export function getAction(provider: string, action: string): ActionAdapter {
  const adapter = registry.get(`${provider}:${action}`);
  if (!adapter) throw new ProviderError('This action is not supported by this platform connector.', 404);
  return adapter;
}
export function validateValues(adapter: ActionAdapter, input: unknown): ActionValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderError('Action values must be an object of field names and strings.');
  const fields = adapter.definition.fields;
  for (const name of Object.keys(input)) if (!fields.some(field => field.name === name)) throw new ProviderError(`Unknown field: ${name.slice(0, 80)}.`);
  const values: ActionValues = {};
  for (const field of fields) {
    const raw = (input as Record<string, unknown>)[field.name] ?? field.default ?? '';
    if (typeof raw !== 'string') throw new ProviderError(`${field.label} must be a string.`);
    const value = field.preserveWhitespace ? raw : raw.trim();
    if (field.required && !value) throw new ProviderError(`${field.label} is required.`);
    const maximum = field.maxLength ?? (field.type === 'file' ? 28_000_000 : 50_000);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 28_000_000) throw new ProviderError('This action has an invalid field size limit.', 500);
    if (value.length > maximum) throw new ProviderError(`${field.label} is too large.`);
    if (value && field.type === 'select' && !field.options?.some(option => option.value === value)) throw new ProviderError(`Choose a valid ${field.label}.`);
    if (value && field.type === 'number' && !Number.isFinite(Number(value))) throw new ProviderError(`${field.label} must be a finite number.`);
    if (value && field.type === 'datetime' && (!Number.isFinite(Date.parse(value)) || !/(Z|[+-]\d\d:\d\d)$/.test(value))) throw new ProviderError(`${field.label} must include a timezone.`);
    if (value && field.type === 'url') {
      let url: URL;
      try { url = new URL(value); } catch { throw new ProviderError(`${field.label} must be an HTTPS URL.`); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new ProviderError(`${field.label} must be an HTTPS URL without embedded credentials.`);
    }
    if (value && field.type === 'file' && !/^data:(video\/[A-Za-z0-9.+-]+|image\/[A-Za-z0-9.+-]+);base64,[A-Za-z0-9+/]+=*$/.test(value)) throw new ProviderError(`${field.label} must be a base64 video or image data URL (up to 20 MiB).`);
    values[field.name] = value;
  }
  return values;
}
