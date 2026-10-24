import { fetchJson, isObject, safeCredential, tokenResponse, type ProviderHttpFailure } from './provider-http';
import { ProviderError, type Credential, type ProviderAdapter } from './provider-types';

// Official contracts: developers.snap.com/marketing-api/Ads-API/authentication
// and /organizations (with_ad_accounts=true includes the user's account roles).
export const snapchatAdsOrigin = 'https://adsapi.snapchat.com/v1/';
const tokenUrl = 'https://accounts.snapchat.com/login/oauth2/access_token';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function snapchatAdsId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ProviderError('Use a valid Snapchat advertising account or campaign UUID.');
  return value;
}
export function snapchatAdsFailure(): never {
  throw new ProviderError('Snapchat Ads returned a failed or unexpected response. Check account permissions and the result in Ads Manager before retrying a write.', 502);
}
export function snapchatAdsObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) snapchatAdsFailure();
  return value;
}
export function snapchatAdsRows(body: unknown, collection: string, entity: string): Record<string, unknown>[] {
  const root = snapchatAdsObject(body);
  if (typeof root.request_status !== 'string' || root.request_status.toUpperCase() !== 'SUCCESS') snapchatAdsFailure();
  const rows = root[collection];
  if (!Array.isArray(rows)) snapchatAdsFailure();
  return rows.map(value => {
    const row = snapchatAdsObject(value);
    if (typeof row.sub_request_status !== 'string' || row.sub_request_status.toUpperCase() !== 'SUCCESS') snapchatAdsFailure();
    return snapchatAdsObject(row[entity]);
  });
}
type DiscoveryStage = 'organizations' | 'organization-adaccounts';
type DiscoveryReason = 'PROVIDER_REJECTED' | 'INVALID_RESPONSE' | 'INVALID_COLLECTION' | 'INVALID_ENTITY' | 'INVALID_ACCOUNT_ID' | 'INVALID_ORGANIZATION_ID' | 'INVALID_INLINE_ACCOUNTS' | 'FALLBACK_LIMIT' | 'HTTP_ERROR' | 'NETWORK_ERROR';
const maxDiscoveryFallbacks = 10;
function discoveryCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647) return String(value);
  return typeof value === 'string' && /^E[0-9]{1,8}$/.test(value) ? value : undefined;
}
function responseCode(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const code = discoveryCode(value.error_code) ?? discoveryCode(value.sub_request_error_code);
  if (code) return code;
  // Snap documents this nested format. Extract only its bounded code, never
  // the remaining provider message (which may contain names or credentials).
  const reason = value.sub_request_error_reason;
  return discoveryCode(reason) ?? (typeof reason === 'string' ? /^Error code: (E[0-9]{1,8}), message:/.exec(reason.slice(0, 64))?.[1] : undefined);
}
function discoveryError(stage: DiscoveryStage, reason: DiscoveryReason, code?: string, httpStatus?: number): ProviderError {
  const read = stage === 'organizations' ? 'advertising organizations' : 'organization advertising accounts';
  const context = [httpStatus === undefined ? '' : `HTTP ${httpStatus}`, `reason SNAP_ADS_${stage === 'organizations' ? 'ORGANIZATIONS' : 'ADACCOUNTS'}_${reason}`, code ? `provider code ${code}` : ''].filter(Boolean).join('; ');
  const help = reason === 'FALLBACK_LIMIT'
    ? `This discovery needs more than ${maxDiscoveryFallbacks} additional organization reads, which exceeds Connector's read limit.`
    : 'Check Snapchat Ads access and reconnect. No advertising changes were sent.';
  return new ProviderError(`Snapchat Ads could not read ${read} (${context}). ${help}`, httpStatus === 401 || httpStatus === 403 || httpStatus === 429 ? httpStatus : 502);
}
function discoveryRows(body: unknown, stage: DiscoveryStage): Record<string, unknown>[] {
  if (!isObject(body)) throw discoveryError(stage, 'INVALID_RESPONSE');
  const collection = stage === 'organizations' ? 'organizations' : 'adaccounts';
  const entity = stage === 'organizations' ? 'organization' : 'adaccount';
  const rows = body[collection];
  if (typeof body.request_status !== 'string' || body.request_status.toUpperCase() !== 'SUCCESS') {
    const code = responseCode(body) ?? (Array.isArray(rows) ? rows.slice(0, 5).map(responseCode).find(value => value !== undefined) : undefined);
    throw discoveryError(stage, 'PROVIDER_REJECTED', code);
  }
  if (!Array.isArray(rows)) throw discoveryError(stage, 'INVALID_COLLECTION');
  return rows.map(value => {
    if (!isObject(value)) throw discoveryError(stage, 'INVALID_ENTITY');
    if (typeof value.sub_request_status !== 'string' || value.sub_request_status.toUpperCase() !== 'SUCCESS') throw discoveryError(stage, 'PROVIDER_REJECTED', responseCode(value));
    if (!isObject(value[entity])) throw discoveryError(stage, 'INVALID_ENTITY');
    return value[entity];
  });
}
function discoveryAccounts(values: unknown[], stage: DiscoveryStage): Record<string, unknown>[] {
  return values.map(value => {
    if (!isObject(value)) throw discoveryError(stage, 'INVALID_ENTITY');
    if (typeof value.id !== 'string' || !uuid.test(value.id)) throw discoveryError(stage, 'INVALID_ACCOUNT_ID');
    return value;
  });
}
async function discoveryRequest(credential: Credential, path: string, stage: DiscoveryStage) {
  return fetchJson('Snapchat Ads', `${snapchatAdsOrigin}${path}`, { method: 'GET', headers: { authorization: `Bearer ${safeCredential(credential)}` } }, {
    failure: (failure: ProviderHttpFailure) => discoveryError(stage, failure.kind === 'http' ? 'HTTP_ERROR' : failure.kind === 'network' ? 'NETWORK_ERROR' : 'INVALID_RESPONSE', discoveryCode(failure.code), failure.status),
  });
}

/** Read-only discovery using the two documented Marketing API account routes. */
export async function discoverSnapchatAdAccounts(credential: Credential): Promise<Record<string, unknown>[]> {
  const organizations = discoveryRows(await discoveryRequest(credential, 'me/organizations?with_ad_accounts=true', 'organizations'), 'organizations');
  const fallbackIds = new Set<string>();
  // Validate the complete plan before requesting any provider-supplied ID.
  const plan = organizations.map(organization => {
    if (organization.ad_accounts === undefined || organization.ad_accounts === null) {
      if (typeof organization.id !== 'string' || !uuid.test(organization.id)) throw discoveryError('organizations', 'INVALID_ORGANIZATION_ID');
      const organizationId = organization.id.toLowerCase();
      fallbackIds.add(organizationId);
      return { organizationId };
    }
    if (!Array.isArray(organization.ad_accounts)) throw discoveryError('organizations', 'INVALID_INLINE_ACCOUNTS');
    return { accounts: discoveryAccounts(organization.ad_accounts, 'organizations') };
  });
  if (fallbackIds.size > maxDiscoveryFallbacks) throw discoveryError('organizations', 'FALLBACK_LIMIT');
  const fallbackAccounts = new Map<string, Record<string, unknown>[]>();
  // At most ten sequential requests: no unbounded fan-out or paging URLs.
  for (const organizationId of fallbackIds) {
    const body = await discoveryRequest(credential, `organizations/${organizationId}/adaccounts`, 'organization-adaccounts');
    fallbackAccounts.set(organizationId, discoveryAccounts(discoveryRows(body, 'organization-adaccounts'), 'organization-adaccounts'));
  }
  const accounts = plan.flatMap(entry => entry.accounts ?? fallbackAccounts.get(entry.organizationId!)!);
  return [...new Map(accounts.map(account => [(account.id as string).toLowerCase(), account])).values()];
}

function setting(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value || /[\r\n\0]/.test(value)) throw new ProviderError(`Configure ${key} before connecting Snapchat Ads.`, 503);
  return value;
}
async function token(env: NodeJS.ProcessEnv, params: Record<string, string>, previous?: Credential): Promise<Credential> {
  const body = await fetchJson('Snapchat Ads', tokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: setting(env, 'SNAPCHAT_ADS_CLIENT_ID'), client_secret: setting(env, 'SNAPCHAT_ADS_CLIENT_SECRET') }),
  });
  if (body.error || (body.scope !== undefined && (typeof body.scope !== 'string' || !body.scope.split(/\s+/).includes('snapchat-marketing-api')))) {
    throw new ProviderError('Snapchat Ads did not grant Marketing API access. Reconnect using the advertising application.', 403);
  }
  const result = tokenResponse(body, previous);
  safeCredential(result);
  if (!result.expiresAt || !result.refreshToken?.trim() || result.refreshToken.length > 8192 || /[\r\n\0]/.test(result.refreshToken)) {
    throw new ProviderError('Snapchat Ads did not return renewable access. Reconnect the advertising account.', 502);
  }
  return result;
}

export const snapchatAdsAdapter: ProviderAdapter = {
  definition: {
    id: 'snapchat-ads', name: 'Snapchat Ads', category: 'advertising', authType: 'oauth',
    description: 'Connect advertising accounts to manage campaigns and daily spending caps and read performance through the Snapchat Marketing API.',
    docsUrl: 'https://developers.snap.com/marketing-api/Ads-API/authentication',
  },
  requiredEnv: ['SNAPCHAT_ADS_CLIENT_ID', 'SNAPCHAT_ADS_CLIENT_SECRET'],
  authorize({ redirectUri, state, env }) {
    const query = new URLSearchParams({ client_id: setting(env, 'SNAPCHAT_ADS_CLIENT_ID'), redirect_uri: redirectUri, response_type: 'code', scope: 'snapchat-marketing-api', state });
    return `https://accounts.snapchat.com/login/oauth2/authorize?${query}`;
  },
  exchange({ code, redirectUri, env }) {
    return token(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  },
  refresh(credential, env) {
    if (!credential.refreshToken?.trim() || credential.refreshToken.length > 8192 || /[\r\n\0]/.test(credential.refreshToken)) throw new ProviderError('Snapchat Ads access cannot be refreshed. Reconnect Snapchat Ads.', 401);
    return token(env, { grant_type: 'refresh_token', refresh_token: credential.refreshToken }, credential);
  },
  async verify(credential) {
    const accounts = await discoverSnapchatAdAccounts(credential);
    return {
      accountName: accounts.length > 100 ? 'Snapchat advertising access (first 100 accounts)' : 'Snapchat advertising access',
      resources: accounts.slice(0, 100).map(account => ({ id: snapchatAdsId(account.id), name: typeof account.name === 'string' && account.name.trim() ? account.name.slice(0, 300) : `Ad account ${account.id}`, type: 'ad_account' })),
    };
  },
};
