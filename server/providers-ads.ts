import { createHash, createHmac, randomBytes } from 'node:crypto';
import { fetchJson, isObject, safeCredential, tokenResponse, type ProviderHttpOptions } from './provider-http.ts';
import { microsoftAdsHttpOptions } from './microsoft-ads-errors.ts';
import { linkedInScopes, linkedInScopeOptions } from './linkedin-scopes.ts';
import { ProviderError, type Credential, type OAuthExchange, type ProviderAdapter, type Resource } from './provider-types.ts';

function configured(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value || /[\r\n]/.test(value)) throw new ProviderError(`Configure ${key} on the server before connecting.`, 503);
  return value;
}

function id(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.slice(0, 300);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function name(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.slice(0, 300) : fallback;
}

function list(value: unknown, provider: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isObject)) {
    throw new ProviderError(`${provider} returned an unexpected account response.`, 502);
  }
  return value;
}

function resourceId(value: unknown, provider: string): string {
  const result = id(value);
  if (!result) throw new ProviderError(`${provider} returned an account without an identifier.`, 502);
  return result;
}

async function formToken(provider: string, url: string, params: Record<string, string>, previous?: Credential, headers?: Record<string, string>, options?: ProviderHttpOptions) {
  const body = await fetchJson(provider, url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  }, options);
  return tokenResponse(body, previous);
}

function withoutRefreshToken(credential: Credential, provider: string): Credential {
  if (credential.expiresAt && credential.expiresAt <= Date.now()) {
    throw new ProviderError(`${provider} access has expired. Reconnect this account.`, 401);
  }
  return credential;
}

const linkedin: ProviderAdapter = {
  definition: {
    id: 'linkedin-ads', name: 'LinkedIn Campaign Manager', category: 'advertising', authType: 'oauth',
    description: 'Verify accessible ad accounts. Requires approved LinkedIn Advertising API access.',
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts',
  },
  requiredEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  authorize({ redirectUri, state, env }) {
    const scope = linkedInScopes(true, linkedInScopeOptions(env)).join(' ');
    const query = new URLSearchParams({ response_type: 'code', client_id: configured(env, 'LINKEDIN_CLIENT_ID'), redirect_uri: redirectUri, state, scope });
    return `https://www.linkedin.com/oauth/v2/authorization?${query}`;
  },
  exchange({ code, redirectUri, env }) {
    return formToken('LinkedIn Campaign Manager', 'https://www.linkedin.com/oauth/v2/accessToken', {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: configured(env, 'LINKEDIN_CLIENT_ID'), client_secret: configured(env, 'LINKEDIN_CLIENT_SECRET'),
    });
  },
  async refresh(credential, env) {
    if (!credential.refreshToken) return withoutRefreshToken(credential, 'LinkedIn Campaign Manager');
    return formToken('LinkedIn Campaign Manager', 'https://www.linkedin.com/oauth/v2/accessToken', {
      grant_type: 'refresh_token', refresh_token: credential.refreshToken,
      client_id: configured(env, 'LINKEDIN_CLIENT_ID'), client_secret: configured(env, 'LINKEDIN_CLIENT_SECRET'),
    }, credential);
  },
  async verify(credential, env) {
    const version = env.LINKEDIN_API_VERSION?.trim() || '202601';
    if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(version)) throw new ProviderError('LINKEDIN_API_VERSION must be a supported YYYYMM release.', 503);
    const body = await fetchJson('LinkedIn Campaign Manager', 'https://api.linkedin.com/rest/adAccounts?q=search&count=100', {
      headers: { authorization: `Bearer ${safeCredential(credential)}`, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' },
    });
    const resources = list(body.elements, 'LinkedIn Campaign Manager').slice(0, 100).map((account) => {
      const accountId = resourceId(account.id, 'LinkedIn Campaign Manager');
      return { id: accountId, name: name(account.name, `Ad account ${accountId}`), type: 'ad_account' };
    });
    return { accountName: 'LinkedIn advertising access', resources };
  },
};

const microsoftScope = 'https://ads.microsoft.com/msads.manage offline_access';
const microsoftTokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const microsoft: ProviderAdapter = {
  definition: {
    id: 'microsoft-ads', name: 'Microsoft Advertising', category: 'advertising', authType: 'oauth',
    description: 'Verify your advertising user, customers, and account roles. Requires a Microsoft Advertising developer token.',
    docsUrl: 'https://learn.microsoft.com/en-us/advertising/customer-management-service/getuser?view=bingads-13',
  },
  requiredEnv: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_ADS_DEVELOPER_TOKEN'],
  authorize({ redirectUri, state, codeVerifier, env }) {
    const query = new URLSearchParams({
      response_type: 'code', client_id: configured(env, 'MICROSOFT_CLIENT_ID'), redirect_uri: redirectUri,
      state, scope: microsoftScope, code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256',
    });
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${query}`;
  },
  exchange({ code, redirectUri, codeVerifier, env }) {
    return formToken('Microsoft Advertising', microsoftTokenUrl, {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier, scope: microsoftScope,
      client_id: configured(env, 'MICROSOFT_CLIENT_ID'), client_secret: configured(env, 'MICROSOFT_CLIENT_SECRET'),
    }, undefined, undefined, microsoftAdsHttpOptions('code-exchange'));
  },
  async refresh(credential, env) {
    if (!credential.refreshToken) return withoutRefreshToken(credential, 'Microsoft Advertising');
    return formToken('Microsoft Advertising', microsoftTokenUrl, {
      grant_type: 'refresh_token', refresh_token: credential.refreshToken, scope: microsoftScope,
      client_id: configured(env, 'MICROSOFT_CLIENT_ID'), client_secret: configured(env, 'MICROSOFT_CLIENT_SECRET'),
    }, credential, undefined, microsoftAdsHttpOptions('token-refresh'));
  },
  async verify(credential, env) {
    // Microsoft's REST GetUser is a read operation despite using POST.
    const body = await fetchJson('Microsoft Advertising', 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13/User/Query', {
      method: 'POST', headers: {
        authorization: `Bearer ${safeCredential(credential)}`, DeveloperToken: configured(env, 'MICROSOFT_ADS_DEVELOPER_TOKEN'), 'content-type': 'application/json',
      }, body: JSON.stringify({ UserId: null }),
    }, microsoftAdsHttpOptions('account-verification'));
    if (!isObject(body.User)) throw new ProviderError('Microsoft Advertising returned an unexpected user response.', 502);
    const accountId = resourceId(body.User.Id, 'Microsoft Advertising');
    const fullName = isObject(body.User.Name) ? [body.User.Name.FirstName, body.User.Name.LastName].filter((part) => typeof part === 'string').join(' ') : '';
    const resources: Resource[] = [];
    for (const role of list(body.CustomerRoles, 'Microsoft Advertising')) {
      const customerId = resourceId(role.CustomerId, 'Microsoft Advertising');
      resources.push({ id: customerId, name: `Customer ${customerId}`, type: 'advertising_customer' });
      for (const value of [role.AccountIds, role.LinkedAccountIds]) {
        if (value != null && !Array.isArray(value)) throw new ProviderError('Microsoft Advertising returned unexpected account roles.', 502);
        for (const rawId of value || []) {
          const account = resourceId(rawId, 'Microsoft Advertising');
          resources.push({ id: account, name: `Ad account ${account}`, type: 'ad_account' });
        }
      }
    }
    const unique = [...new Map(resources.map((resource) => [`${resource.type}:${resource.id}`, resource])).values()].slice(0, 100);
    return { accountId, accountName: name(fullName, name(body.User.UserName, 'Microsoft Advertising user')), resources: unique };
  },
};

function tiktokData(body: Record<string, unknown>): Record<string, unknown> {
  if (body.code !== 0) throw new ProviderError('TikTok Business denied this request. Check app approval, Business Center permissions, and token validity.', 403);
  if (!isObject(body.data)) throw new ProviderError('TikTok Business returned an unexpected response.', 502);
  return body.data;
}

const tiktok: ProviderAdapter = {
  definition: {
    id: 'tiktok-business', name: 'TikTok Business Manager', category: 'advertising', authType: 'oauth',
    description: 'Verify access to TikTok Business Centers through the API for Business. Requires an approved business developer app.',
    docsUrl: 'https://business-api.tiktok.com/portal/docs?id=1737115687501826',
  },
  requiredEnv: ['TIKTOK_BUSINESS_APP_ID', 'TIKTOK_BUSINESS_APP_SECRET'],
  authorize({ redirectUri, state, env }) {
    const query = new URLSearchParams({ app_id: configured(env, 'TIKTOK_BUSINESS_APP_ID'), redirect_uri: redirectUri, state });
    return `https://business-api.tiktok.com/portal/auth?${query}`;
  },
  async exchange({ code, env }: OAuthExchange) {
    const body = await fetchJson('TikTok Business', 'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        app_id: configured(env, 'TIKTOK_BUSINESS_APP_ID'), secret: configured(env, 'TIKTOK_BUSINESS_APP_SECRET'), auth_code: code,
      }),
    });
    return tokenResponse(tiktokData(body));
  },
  async verify(credential) {
    const body = await fetchJson('TikTok Business', 'https://business-api.tiktok.com/open_api/v1.3/bc/get/?page=1&page_size=50', {
      headers: { 'Access-Token': safeCredential(credential) },
    });
    const data = tiktokData(body);
    const resources = list(data.list, 'TikTok Business').slice(0, 50).map((item) => {
      if (!isObject(item.bc_info)) throw new ProviderError('TikTok Business returned an unexpected Business Center.', 502);
      const accountId = resourceId(item.bc_info.bc_id, 'TikTok Business');
      return { id: accountId, name: name(item.bc_info.name, `Business Center ${accountId}`), type: 'business_center' };
    });
    return { accountName: 'TikTok Business Center access', resources };
  },
};

function oauthEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function xCredential(credential: Credential, field: string, label: string): string {
  const value = credential.fields?.[field];
  if (!value?.trim() || value.length > 8192 || /[\r\n]/.test(value)) throw new ProviderError(`A valid ${label} is required for X Ads.`);
  return value.trim();
}

/** OAuth 1.0a includes form parameters but excludes JSON bodies from its signature base. */
export function xAuthorization(url: string, credential: Credential, method = 'GET', form?: URLSearchParams): string {
  const consumerKey = xCredential(credential, 'consumerKey', 'consumer key');
  const consumerSecret = xCredential(credential, 'consumerSecret', 'consumer secret');
  const accessTokenSecret = xCredential(credential, 'accessTokenSecret', 'access token secret');
  const oauth: Record<string, string> = {
    oauth_consumer_key: consumerKey, oauth_nonce: randomBytes(24).toString('hex'), oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: safeCredential(credential), oauth_version: '1.0',
  };
  const parsed = new URL(url);
  const parameters = [...parsed.searchParams.entries(), ...(form?.entries() || []), ...Object.entries(oauth)].map(([key, value]) => [oauthEncode(key), oauthEncode(value)]);
  parameters.sort(([aKey, aValue], [bKey, bValue]) => aKey < bKey ? -1 : aKey > bKey ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0);
  const normalized = parameters.map(([key, value]) => `${key}=${value}`).join('&');
  const base = [method.toUpperCase(), oauthEncode(`${parsed.origin}${parsed.pathname}`), oauthEncode(normalized)].join('&');
  oauth.oauth_signature = createHmac('sha1', `${oauthEncode(consumerSecret)}&${oauthEncode(accessTokenSecret)}`).update(base).digest('base64');
  return `OAuth ${Object.entries(oauth).map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`).join(', ')}`;
}

const xAds: ProviderAdapter = {
  definition: {
    id: 'x-ads', name: 'X Business / Ads', category: 'advertising', authType: 'api_key',
    description: 'Verify advertising accounts with approved X Ads API OAuth 1.0a credentials. Enter the user access token and its three companion credentials.',
    docsUrl: 'https://docs.x.com/x-ads-api/accounts-and-users/overview',
    credentialFields: [
      { name: 'consumerKey', label: 'App consumer key', secret: true },
      { name: 'consumerSecret', label: 'App consumer secret', secret: true },
      { name: 'accessTokenSecret', label: 'User access token secret', secret: true },
    ],
  },
  requiredEnv: [],
  async verify(credential, env) {
    const version = env.X_ADS_API_VERSION?.trim() || '12';
    if (!/^\d{1,3}$/.test(version)) throw new ProviderError('X_ADS_API_VERSION must be a supported numeric API version.', 503);
    const url = `https://ads-api.x.com/${version}/accounts?count=1000`;
    const body = await fetchJson('X Ads', url, { headers: { authorization: xAuthorization(url, credential) } });
    const resources = list(body.data, 'X Ads').slice(0, 100).map((account) => {
      const accountId = resourceId(account.id, 'X Ads');
      return { id: accountId, name: name(account.name, `Ad account ${accountId}`), type: 'ad_account' };
    });
    return { accountName: 'X advertising access', resources };
  },
};

function redditHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const userAgent = env.REDDIT_USER_AGENT?.trim() || 'web:connector:0.1.0';
  if (/[\r\n]/.test(userAgent)) throw new ProviderError('REDDIT_USER_AGENT must be a single line.', 503);
  return {
    authorization: `Basic ${Buffer.from(`${configured(env, 'REDDIT_ADS_CLIENT_ID')}:${configured(env, 'REDDIT_ADS_CLIENT_SECRET')}`).toString('base64')}`,
    'user-agent': userAgent,
  };
}

const reddit: ProviderAdapter = {
  definition: {
    id: 'reddit-ads', name: 'Reddit Ads', category: 'advertising', authType: 'oauth',
    description: 'Connect a configured Reddit ad account with approved adsread and adsedit permissions. Uses a dedicated advertising OAuth app.',
    docsUrl: 'https://ads-api.reddit.com/docs/v3/',
  },
  requiredEnv: ['REDDIT_ADS_CLIENT_ID', 'REDDIT_ADS_CLIENT_SECRET', 'REDDIT_ADS_ACCOUNT_ID'],
  authorize({ redirectUri, state, env }) {
    const query = new URLSearchParams({ response_type: 'code', client_id: configured(env, 'REDDIT_ADS_CLIENT_ID'), redirect_uri: redirectUri, state, duration: 'permanent', scope: 'adsread adsedit' });
    return `https://www.reddit.com/api/v1/authorize?${query}`;
  },
  exchange({ code, redirectUri, env }) {
    return formToken('Reddit Ads', 'https://www.reddit.com/api/v1/access_token', {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    }, undefined, redditHeaders(env));
  },
  async refresh(credential, env) {
    if (!credential.refreshToken) return withoutRefreshToken(credential, 'Reddit Ads');
    return formToken('Reddit Ads', 'https://www.reddit.com/api/v1/access_token', {
      grant_type: 'refresh_token', refresh_token: credential.refreshToken,
    }, credential, redditHeaders(env));
  },
  async verify(credential, env) {
    const accountId = configured(env, 'REDDIT_ADS_ACCOUNT_ID');
    if (!/^[a-zA-Z0-9_-]{1,150}$/.test(accountId)) throw new ProviderError('REDDIT_ADS_ACCOUNT_ID must be the ad account identifier from Reddit Ads.', 503);
    const body = await fetchJson('Reddit Ads', `https://ads-api.reddit.com/api/v3/ad_accounts/${encodeURIComponent(accountId)}/campaigns`, {
      headers: { authorization: `Bearer ${safeCredential(credential)}`, 'user-agent': redditHeaders(env)['user-agent'] },
    });
    // A successful, valid campaign-list response establishes adsread access even for an empty account.
    list(body.data, 'Reddit Ads');
    return { accountName: `Reddit Ads account ${accountId}`, accountId, resources: [{ id: accountId, name: `Ad account ${accountId}`, type: 'ad_account' }] };
  },
};

export const adsAdapters: ProviderAdapter[] = [linkedin, microsoft, tiktok, xAds, reddit];
