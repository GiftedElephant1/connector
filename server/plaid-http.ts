import { ProviderError, type Credential } from './provider-types';
import { isObject, safeCredential, type JsonObject } from './provider-http';

export type PlaidEnvironment = 'sandbox' | 'production';
const origins = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' } as const;
const paths = new Set(['/link/token/create', '/item/public_token/exchange', '/accounts/get', '/accounts/balance/get', '/transactions/get', '/item/remove']);

export function plaidConfig(env: NodeJS.ProcessEnv) {
  const environment = env.PLAID_ENV?.trim() || 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production') throw new ProviderError('Choose Sandbox or Production in Plaid settings.');
  const clientId = env.PLAID_CLIENT_ID?.trim();
  const secret = env.PLAID_SECRET?.trim();
  if (!clientId || !secret || clientId.length > 512 || secret.length > 512 || /[\r\n]/.test(clientId + secret)) {
    throw new ProviderError('Save your Plaid client ID and secret in connection settings first.');
  }
  return { environment, clientId, secret, origin: origins[environment] };
}

export function plaidCountryCodes(env: NodeJS.ProcessEnv): string[] {
  const supported = new Set(['US', 'GB', 'ES', 'NL', 'FR', 'IE', 'CA', 'DE', 'IT', 'PL', 'DK', 'NO', 'SE', 'EE', 'LT', 'LV', 'PT', 'BE', 'AT', 'FI']);
  const countries = [...new Set((env.PLAID_COUNTRY_CODES?.trim() || 'US').split(',').map(value => value.trim().toUpperCase()))];
  if (!countries.length || countries.some(country => !supported.has(country))) throw new ProviderError('Choose supported Plaid country codes, separated by commas.');
  return countries;
}

export function plaidCredential(credential: Credential, env: NodeJS.ProcessEnv): string {
  const config = plaidConfig(env);
  if (credential.fields?.plaidEnvironment !== config.environment || credential.fields?.plaidClientId !== config.clientId) {
    throw new ProviderError('This bank connection belongs to different Plaid settings. Restore its original environment and client ID before disconnecting or reading it.', 409);
  }
  return safeCredential(credential);
}

export function plaidLabel(env: NodeJS.ProcessEnv): string {
  return plaidConfig(env).environment === 'sandbox' ? 'Plaid SANDBOX test data' : 'Plaid bank data';
}

/** The endpoint is fixed by the adapter. Plaid secrets and response bodies never appear in errors. */
export async function plaidRequest(path: string, payload: JsonObject, env: NodeJS.ProcessEnv, credential?: Credential): Promise<JsonObject> {
  if (!paths.has(path)) throw new ProviderError('This Plaid operation is not supported.');
  const config = plaidConfig(env);
  const accessToken = credential ? plaidCredential(credential, env) : undefined;
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`${config.origin}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'Plaid-Version': '2020-09-14' },
      body: JSON.stringify({ ...payload, client_id: config.clientId, secret: config.secret, ...(accessToken ? { access_token: accessToken } : {}) }),
      redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
    body = await response.json();
  } catch {
    throw new ProviderError('Plaid could not complete the request. Check the connection and try again.', 502);
  }
  if (!isObject(body)) throw new ProviderError('Plaid returned an invalid response. Try again later.', 502);
  if (!response.ok || body.error_code || body.error_type) {
    if (body.error_code === 'PRODUCT_NOT_READY') throw new ProviderError('Plaid is still preparing transaction history. Wait a moment and try again.', 422);
    if (body.error_code === 'ITEM_LOGIN_REQUIRED') throw new ProviderError('Your bank requires authorization again. Disconnect this bank connection and connect again.', 422);
    if (response.status === 429) throw new ProviderError('Plaid is rate limiting requests. Try again later.', 429);
    if (response.status === 401 || response.status === 403) throw new ProviderError('Plaid denied this request. Check your credentials and product access.', 403);
    throw new ProviderError('Plaid could not complete the request. Check your Plaid settings and bank connection.', 502);
  }
  return body;
}

export function plaidRecords(body: JsonObject, key: string, maximum = 100): JsonObject[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length > maximum || !value.every(isObject)) throw new ProviderError('Plaid returned an invalid or oversized result.', 502);
  return value;
}

export function plaidText(value: unknown, maximum = 160): string {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}

export function maskedAccount(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,12}$/.test(value) ? `•••• ${value.slice(-4)}` : '';
}
