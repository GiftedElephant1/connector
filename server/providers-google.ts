import { createHash } from 'node:crypto';
import { fetchJson, isObject, safeCredential, tokenResponse, type JsonObject } from './provider-http.ts';
import {
  ProviderError, type Credential, type OAuthExchange, type OAuthRequest,
  type ProviderAdapter, type ProviderDefinition, type Resource, type VerifiedAccount,
} from './provider-types.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USER_INFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const MAX_RESOURCES = 100;

type GoogleConfig = {
  definition: ProviderDefinition;
  scope: string;
  endpoint: string;
  emptyMessage: string;
  resources: (body: JsonObject) => Resource[];
};

function envValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value || value.length > 8192 || /[\r\n]/.test(value)) {
    throw new ProviderError(`Configure ${key} in the server environment before connecting.`);
  }
  return value;
}

function collection(body: JsonObject, key: string): unknown[] {
  // Google protobuf JSON omits repeated fields when an account has no resources.
  if (body.error !== undefined || (body[key] !== undefined && !Array.isArray(body[key]))) {
    throw new ProviderError('Google returned an unexpected resource list. Try again later.', 502);
  }
  return (body[key] as unknown[] | undefined) ?? [];
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, 300) : undefined;
}

const configs: GoogleConfig[] = [
  {
    definition: {
      id: 'youtube', name: 'YouTube', category: 'social', authType: 'oauth',
      description: 'Connect your YouTube channel to upload videos, reply to comments and read channel analytics.',
      docsUrl: 'https://developers.google.com/youtube/v3/docs/channels/list',
    },
    scope: ['youtube.readonly', 'youtube.upload', 'youtube.force-ssl', 'yt-analytics.readonly'].map((scope) => `https://www.googleapis.com/auth/${scope}`).join(' '),
    endpoint: 'https://youtube.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50',
    emptyMessage: 'no YouTube channels returned',
    resources: (body) => collection(body, 'items').filter(isObject).flatMap((item) => {
      const id = textField(item.id);
      const name = isObject(item.snippet) ? textField(item.snippet.title) : undefined;
      return id ? [{ id, name: name ?? id, type: 'YouTube channel' }] : [];
    }).slice(0, 50),
  },
  {
    definition: {
      id: 'google-ads', name: 'Google Ads', category: 'advertising', authType: 'oauth',
      description: 'Verify directly accessible Google Ads customer accounts. Requires a developer token.',
      docsUrl: 'https://developers.google.com/google-ads/api/docs/account-management/listing-accounts',
    },
    scope: 'https://www.googleapis.com/auth/adwords',
    endpoint: 'https://googleads.googleapis.com/v25/customers:listAccessibleCustomers',
    emptyMessage: 'no directly accessible Google Ads customers returned',
    resources: (body) => collection(body, 'resourceNames').flatMap((value) => {
      if (typeof value !== 'string' || !/^customers\/\d+$/.test(value)) return [];
      return [{ id: value, name: `Google Ads customer ${value.slice('customers/'.length)}`, type: 'Google Ads customer' }];
    }).slice(0, MAX_RESOURCES),
  },
  {
    definition: {
      id: 'google-analytics', name: 'Google Analytics', category: 'analytics', authType: 'oauth',
      description: 'Read GA4 traffic and manage key event settings for properties you are allowed to edit.',
      docsUrl: 'https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list',
    },
    scope: 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/analytics.edit',
    endpoint: 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=100',
    emptyMessage: 'no Google Analytics accounts returned',
    resources: (body) => {
      const resources: Resource[] = [];
      for (const account of collection(body, 'accountSummaries').filter(isObject)) {
        const id = textField(account.account);
        if (id) resources.push({ id, name: textField(account.displayName) ?? id, type: 'Analytics account' });
        for (const property of collection(account, 'propertySummaries').filter(isObject)) {
          const propertyId = textField(property.property);
          if (propertyId) resources.push({ id: propertyId, name: textField(property.displayName) ?? propertyId, type: 'GA4 property' });
          if (resources.length >= MAX_RESOURCES) return resources.slice(0, MAX_RESOURCES);
        }
        if (resources.length >= MAX_RESOURCES) break;
      }
      return resources.slice(0, MAX_RESOURCES);
    },
  },
  {
    definition: {
      id: 'search-console', name: 'Google Search Console', category: 'analytics', authType: 'oauth',
      description: 'Read search performance and submit or remove sitemap submissions for properties you can manage.',
      docsUrl: 'https://developers.google.com/webmaster-tools/v1/sites/list',
    },
    scope: 'https://www.googleapis.com/auth/webmasters',
    endpoint: 'https://searchconsole.googleapis.com/webmasters/v3/sites',
    emptyMessage: 'no verified Search Console properties returned',
    resources: (body) => collection(body, 'siteEntry').filter(isObject).flatMap((site) => {
      const id = textField(site.siteUrl);
      // A listed but unverified site does not establish access to its data.
      return id && ['siteOwner', 'siteFullUser', 'siteRestrictedUser'].includes(String(site.permissionLevel))
        ? [{ id, name: id, type: 'Search Console property' }] : [];
    }).slice(0, MAX_RESOURCES),
  },
];

function authorize(config: GoogleConfig, input: OAuthRequest): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: envValue(input.env, 'GOOGLE_CLIENT_ID'),
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: `openid email ${config.scope}`,
    state: input.state,
    code_challenge: createHash('sha256').update(input.codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent select_account',
  }).toString();
  return url.toString();
}

async function exchange(input: OAuthExchange): Promise<Credential> {
  return tokenResponse(await fetchJson('Google', TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: envValue(input.env, 'GOOGLE_CLIENT_ID'),
      client_secret: envValue(input.env, 'GOOGLE_CLIENT_SECRET'),
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  }));
}

async function refresh(credential: Credential, env: NodeJS.ProcessEnv): Promise<Credential> {
  if (!credential.refreshToken) {
    throw new ProviderError('Google did not grant offline access. Reconnect to renew this connection.', 401);
  }
  return tokenResponse(await fetchJson('Google', TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: envValue(env, 'GOOGLE_CLIENT_ID'),
      client_secret: envValue(env, 'GOOGLE_CLIENT_SECRET'),
    }),
  }), credential);
}

async function verify(config: GoogleConfig, credential: Credential, env: NodeJS.ProcessEnv): Promise<VerifiedAccount> {
  const headers: Record<string, string> = { authorization: `Bearer ${safeCredential(credential)}` };
  const resourceHeaders = { ...headers };
  if (config.definition.id === 'google-ads') resourceHeaders['developer-token'] = envValue(env, 'GOOGLE_ADS_DEVELOPER_TOKEN');
  // Identity scopes provide a stable Google subject and an email label without profile access.
  const identity = await fetchJson(config.definition.name, USER_INFO_URL, { headers });
  const accountId = textField(identity.sub);
  if (!accountId || identity.error !== undefined) {
    throw new ProviderError('Google did not return an account identity. Reconnect and grant the requested access.', 502);
  }
  const body = await fetchJson(config.definition.name, config.endpoint, { headers: resourceHeaders });
  const resources = config.resources(body);
  const accountName = textField(identity.email) ?? 'Google account';
  return {
    accountId,
    accountName: resources.length ? accountName : `${accountName} (${config.emptyMessage})`,
    resources,
  };
}

export const googleAdapters: ProviderAdapter[] = configs.map((config) => ({
  definition: config.definition,
  requiredEnv: [
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    ...(config.definition.id === 'google-ads' ? ['GOOGLE_ADS_DEVELOPER_TOKEN'] : []),
  ],
  authorize: (input) => authorize(config, input),
  exchange,
  refresh,
  verify: (credential, env) => verify(config, credential, env),
}));
