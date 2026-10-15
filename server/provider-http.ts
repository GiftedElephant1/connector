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

export type ProviderHttpFailure = {
  kind: 'http' | 'network' | 'invalid-response';
  status?: number;
  code?: number;
  subcode?: number;
  oauthError?: 'invalid_client' | 'invalid_grant' | 'invalid_scope' | 'unauthorized_client' | 'interaction_required' | 'consent_required' | 'access_denied' | 'invalid_request' | 'temporarily_unavailable' | 'server_error';
};
export type ProviderHttpOptions = {
  /** Receives only bounded numeric diagnostics and allowlisted codes, never upstream text or credentials. */
  failure?: (failure: ProviderHttpFailure) => ProviderError;
  diagnosticFormat?: 'microsoft-identity' | 'microsoft-ads';
};

function diagnosticNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : undefined;
}

const oauthErrors: NonNullable<ProviderHttpFailure['oauthError']>[] = ['invalid_client', 'invalid_grant', 'invalid_scope', 'unauthorized_client', 'interaction_required', 'consent_required', 'access_denied', 'invalid_request', 'temporarily_unavailable', 'server_error'];

/** Error payloads are untrusted. Bound the body and extract only codes for the selected protocol. */
async function errorCodes(response: Response, format?: ProviderHttpOptions['diagnosticFormat']): Promise<Pick<ProviderHttpFailure, 'code' | 'subcode' | 'oauthError'>> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16_384) {
          await reader.cancel();
          return {};
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isObject(body)) return {};
    if (format === 'microsoft-identity') {
      const code = Array.isArray(body.error_codes) ? diagnosticNumber(body.error_codes[0]) : undefined;
      const oauthError = oauthErrors.find(value => value === body.error);
      return { ...(code !== undefined ? { code } : {}), ...(oauthError ? { oauthError } : {}) };
    }
    if (format === 'microsoft-ads') {
      // Advertising REST faults use PascalCase, unlike Entra's OAuth response.
      for (const errors of [body.Errors, body.OperationErrors]) {
        if (!Array.isArray(errors)) continue;
        for (const entry of errors.slice(0, 5)) {
          const code = isObject(entry) ? diagnosticNumber(entry.Code) : undefined;
          if (code !== undefined) return { code };
        }
      }
      return {};
    }
    const nested = isObject(body.error) ? body.error : {};
    const code = diagnosticNumber(nested.code) ?? diagnosticNumber(body.error_code) ?? diagnosticNumber(body.code);
    const subcode = diagnosticNumber(nested.error_subcode) ?? diagnosticNumber(body.error_subcode);
    return { ...(code !== undefined ? { code } : {}), ...(subcode !== undefined ? { subcode } : {}) };
  } catch {
    return {};
  }
}

/** Call only fixed official API origins. Upstream responses and thrown errors are never included in public errors. */
async function fetchJsonBody(providerName: string, url: string, init: RequestInit = {}, options: ProviderHttpOptions = {}): Promise<unknown> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000), headers });
  } catch {
    if (options.failure) throw options.failure({ kind: 'network' });
    throw new ProviderError(`${providerName} could not be reached. Check connectivity and try again.`, 502);
  }
  if (!response.ok) {
    if (options.failure) throw options.failure({ kind: 'http', status: response.status, ...await errorCodes(response, options.diagnosticFormat) });
    if (response.status === 401) throw new ProviderError(`${providerName} rejected this credential. Reconnect with a valid credential.`, 401);
    if (response.status === 403) throw new ProviderError(`${providerName} denied access. Check the account's permissions and app approval.`, 403);
    if (response.status === 429) throw new ProviderError(`${providerName} is rate limiting requests. Try again later.`, 429);
    throw new ProviderError(`${providerName} could not complete the request (HTTP ${response.status}).`, 502);
  }
  let body: unknown;
  try { body = await response.json(); } catch {
    if (options.failure) throw options.failure({ kind: 'invalid-response', status: response.status });
    throw new ProviderError(`${providerName} returned an invalid response. Try again later.`, 502);
  }
  return body;
}

export async function fetchJson(providerName: string, url: string, init: RequestInit = {}, options: ProviderHttpOptions = {}): Promise<JsonObject> {
  const body = await fetchJsonBody(providerName, url, init, options);
  if (!isObject(body)) {
    if (options.failure) throw options.failure({ kind: 'invalid-response' });
    throw new ProviderError(`${providerName} returned an invalid response. Try again later.`, 502);
  }
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
