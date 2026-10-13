import { ProviderError, type Credential } from './provider-types';
import { safeCredential, isObject } from './provider-http';
import type { ActionValues } from './action-types';

/** Adapters must provide fixed official API origins. No user-provided fetch destinations. */
export async function apiRequest(provider: string, url: string, init: RequestInit = {}): Promise<{ body: unknown; headers: Headers }> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    response = await fetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new ProviderError(`${provider} did not return a response. For a publishing or advertising action, check the platform before retrying: it may have accepted the request.`, 502);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ProviderError(`${provider} denied this action. Reconnect with the required permissions and check your app's access tier.`, 403);
    if (response.status === 429) throw new ProviderError(`${provider} is rate limiting requests. Check the platform before retrying a write.`, 429);
    throw new ProviderError(`${provider} could not complete this action (HTTP ${response.status}). Check the platform before retrying a write.`, 502);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return { body: {}, headers: response.headers };
  let text: string;
  try { text = await response.text(); }
  catch { throw new ProviderError(`${provider} did not finish returning a response. Check the platform before retrying a write.`, 502); }
  if (!text) return { body: {}, headers: response.headers };
  try { return { body: JSON.parse(text), headers: response.headers }; }
  catch { throw new ProviderError(`${provider} returned an unreadable response. Check the platform before retrying a write.`, 502); }
}
export async function apiJson(provider: string, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const result = await apiRequest(provider, url, init);
  if (!isObject(result.body)) throw new ProviderError(`${provider} returned an unexpected response.`, 502);
  return result.body;
}
export function bearer(credential: Credential): Record<string, string> { return { authorization: `Bearer ${safeCredential(credential)}` }; }
export function jsonBody(value: unknown): Pick<RequestInit, 'body' | 'headers'> { return { body: JSON.stringify(value), headers: { 'content-type': 'application/json' } }; }
export function required(values: ActionValues, key: string, label = key): string {
  const value = values[key]?.trim();
  if (!value) throw new ProviderError(`${label} is required.`);
  return value;
}
export function identifier(values: ActionValues, key: string, label = key): string {
  const value = required(values, key, label);
  if (!/^[A-Za-z0-9_:.@\/-]{1,300}$/.test(value)) throw new ProviderError(`${label} is not a valid identifier.`);
  return value;
}
export function numeric(values: ActionValues, key: string, minimum = 0): number {
  const value = Number(required(values, key));
  if (!Number.isFinite(value) || value < minimum) throw new ProviderError(`${key} must be a number of at least ${minimum}.`);
  return value;
}
export function httpsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError('Enter a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ProviderError('Use an HTTPS URL without embedded credentials.');
  return url.toString();
}
export function epochSeconds(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new ProviderError('Enter a valid date and time.');
  return Math.floor(time / 1000);
}
export function string(value: unknown, fallback = ''): string { return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 2000) : fallback; }
export function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter(isObject).slice(0, 100) : []; }
