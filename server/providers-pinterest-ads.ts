import { fetchJson, isObject, safeCredential, tokenResponse } from './provider-http';
import { ProviderError, type Credential, type ProviderAdapter } from './provider-types';

function setting(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value || /[\r\n]/.test(value)) throw new ProviderError(`Configure ${key} before connecting Pinterest Ads.`, 503);
  return value;
}

async function token(env: NodeJS.ProcessEnv, params: Record<string, string>, previous?: Credential): Promise<Credential> {
  const basic = Buffer.from(`${setting(env, 'PINTEREST_ADS_CLIENT_ID')}:${setting(env, 'PINTEREST_ADS_CLIENT_SECRET')}`).toString('base64');
  const body = await fetchJson('Pinterest Ads', 'https://api.pinterest.com/v5/oauth/token', {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, continuous_refresh: 'true' }),
  });
  return tokenResponse(body, previous);
}

export const pinterestAdsAdapter: ProviderAdapter = {
  definition: {
    id: 'pinterest-ads', name: 'Pinterest Ads', category: 'advertising', authType: 'oauth',
    description: 'Connect advertising accounts to manage campaigns and budgets and read spend. Requires Pinterest Ads API access.',
    docsUrl: 'https://developers.pinterest.com/docs/api/v5/ad_accounts-list/',
  },
  // Separate settings and credentials keep organic Pinterest setup independent.
  requiredEnv: ['PINTEREST_ADS_CLIENT_ID', 'PINTEREST_ADS_CLIENT_SECRET'],
  authorize({ redirectUri, state, env }) {
    const query = new URLSearchParams({
      client_id: setting(env, 'PINTEREST_ADS_CLIENT_ID'), redirect_uri: redirectUri,
      response_type: 'code', scope: 'ads:read,ads:write', state,
    });
    return `https://www.pinterest.com/oauth/?${query}`;
  },
  exchange({ code, redirectUri, env }) {
    return token(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  },
  async refresh(credential, env) {
    if (!credential.refreshToken?.trim() || /[\r\n]/.test(credential.refreshToken)) {
      throw new ProviderError('Pinterest Ads access cannot be refreshed. Reconnect Pinterest Ads.', 401);
    }
    return token(env, { grant_type: 'refresh_token', refresh_token: credential.refreshToken }, credential);
  },
  async verify(credential) {
    // Pinterest includes shared Business Access accounts by default. This is a
    // bounded first-page preview; actions still take an explicit account ID.
    const body = await fetchJson('Pinterest Ads', 'https://api.pinterest.com/v5/ad_accounts?page_size=100', {
      headers: { authorization: `Bearer ${safeCredential(credential)}` },
    });
    if (!Array.isArray(body.items) || !body.items.every(isObject)) {
      throw new ProviderError('Pinterest Ads returned an unexpected account list.', 502);
    }
    const resources = body.items.slice(0, 100).map(account => {
      const id = typeof account.id === 'string' ? account.id
        : typeof account.id === 'number' && Number.isSafeInteger(account.id) ? String(account.id) : '';
      if (!/^\d{1,18}$/.test(id)) throw new ProviderError('Pinterest Ads returned an account without a valid identifier.', 502);
      const name = typeof account.name === 'string' && account.name.trim() ? account.name.trim().slice(0, 256) : `Ad account ${id}`;
      return { id, name, type: 'ad_account' };
    });
    return { accountName: 'Pinterest advertising access', resources: [...new Map(resources.map(resource => [resource.id, resource])).values()] };
  },
};
