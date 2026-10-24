import { fetchJson, isObject, safeCredential, tokenResponse } from './provider-http';
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
export function snapchatAdAccounts(body: unknown): Record<string, unknown>[] {
  const accounts: Record<string, unknown>[] = [];
  for (const organization of snapchatAdsRows(body, 'organizations', 'organization')) {
    if (!Array.isArray(organization.ad_accounts) || !organization.ad_accounts.every(isObject)) snapchatAdsFailure();
    for (const account of organization.ad_accounts) {
      snapchatAdsId(account.id);
      accounts.push(account);
    }
  }
  return [...new Map(accounts.map(account => [account.id, account])).values()];
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
    const body = await fetchJson('Snapchat Ads', `${snapchatAdsOrigin}me/organizations?with_ad_accounts=true`, { headers: { authorization: `Bearer ${safeCredential(credential)}` } });
    const accounts = snapchatAdAccounts(body);
    return {
      accountName: accounts.length > 100 ? 'Snapchat advertising access (first 100 accounts)' : 'Snapchat advertising access',
      resources: accounts.slice(0, 100).map(account => ({ id: snapchatAdsId(account.id), name: typeof account.name === 'string' && account.name.trim() ? account.name.slice(0, 300) : `Ad account ${account.id}`, type: 'ad_account' })),
    };
  },
};
