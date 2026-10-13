import { ProviderError, type Credential } from './provider-types.ts';

export type JsonObject = Record<string, unknown>;
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeCredential(credential: Credential): string {
  const token = credential.accessToken;
  if (typeof token !== 'string' || !token.trim() || token.length > 8192 || /[\r\n]/.test(token)) {
    throw new ProviderError('A valid API key or access token is required.');
  }
  return token.trim();
}

/** Call only fixed official API origins. Upstream responses and thrown errors are never included in public errors. */
async function fetchJsonBody(providerName: string, url: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000), headers });
  } catch {
    throw new ProviderError(`${providerName} could not be reached. Check connectivity and try again.`, 502);
  }
  if (!response.ok) {
    if (response.status === 401) throw new ProviderError(`${providerName} rejected this credential. Reconnect with a valid credential.`, 401);
    if (response.status === 403) throw new ProviderError(`${providerName} denied access. Check the account's permissions and app approval.`, 403);
    if (response.status === 429) throw new ProviderError(`${providerName} is rate limiting requests. Try again later.`, 429);
    throw new ProviderError(`${providerName} could not complete the request (HTTP ${response.status}).`, 502);
  }
  let body: unknown;
  try { body = await response.json(); } catch {
    throw new ProviderError(`${providerName} returned an invalid response. Try again later.`, 502);
  }
  return body;
}

export async function fetchJson(providerName: string, url: string, init: RequestInit = {}): Promise<JsonObject> {
  const body = await fetchJsonBody(providerName, url, init);
  if (!isObject(body)) throw new ProviderError(`${providerName} returned an invalid response. Try again later.`, 502);
  return body;
}

/** For official endpoints whose JSON response is a top-level array. Object endpoints remain strict. */
export async function fetchJsonArray(providerName: string, url: string, init: RequestInit = {}): Promise<JsonObject[]> {
  const body = await fetchJsonBody(providerName, url, init);
  if (!Array.isArray(body) || !body.every(isObject)) {
    throw new ProviderError(`${providerName} returned an invalid response. Try again later.`, 502);
  }
  return body.slice(0, 100);
}

export function tokenResponse(body: JsonObject, previous?: Credential): Credential {
  if (typeof body.access_token !== 'string' || !body.access_token.trim()) {
    throw new ProviderError('The provider did not return a usable access token. Check the app configuration and reconnect.', 502);
  }
  const expirySeconds = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === 'string' && body.refresh_token ? { refreshToken: body.refresh_token }
      : previous?.refreshToken ? { refreshToken: previous.refreshToken } : {}),
    ...(Number.isFinite(expirySeconds) && expirySeconds > 0 ? { expiresAt: Date.now() + expirySeconds * 1000 } : {}),
    ...(typeof body.token_type === 'string' ? { tokenType: body.token_type } : {}),
    ...(previous?.fields ? { fields: previous.fields } : {}),
  };
}
