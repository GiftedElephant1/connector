import { createHmac } from 'node:crypto';
import { fetchJson, isObject, safeCredential, tokenResponse, type JsonObject } from './provider-http.ts';
import { ProviderError, type Credential, type OAuthExchange, type OAuthRequest, type ProviderAdapter, type Resource, type VerifiedAccount } from './provider-types.ts';
import { threadsHttpOptions } from './threads-errors.ts';

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ProviderError(`Set ${name} in the server configuration before connecting.`);
  return value;
}

function version(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback;
  if (!/^v\d+\.\d+$/.test(value)) throw new ProviderError(`${name} must be an API version such as ${fallback}.`);
  return value;
}

function metaUrl(path: string, env: NodeJS.ProcessEnv, params: Record<string, string> = {}): URL {
  const url = new URL(`https://graph.facebook.com/${version(env, 'META_API_VERSION', 'v26.0')}/${path}`);
  url.search = new URLSearchParams(params).toString();
  return url;
}

async function metaRead(name: string, path: string, credential: Credential, env: NodeJS.ProcessEnv, params: Record<string, string>): Promise<JsonObject> {
  const token = safeCredential(credential);
  const proof = createHmac('sha256', envValue(env, 'META_APP_SECRET')).update(token).digest('hex');
  const url = metaUrl(path, env, { ...params, appsecret_proof: proof });
  const body = await fetchJson(name, url.toString(), { headers: { authorization: `Bearer ${token}` } });
  if (body.error) throw new ProviderError(`${name} denied this request. Check permissions and reconnect.`, 403);
  return body;
}

function metaAuthorize(scopes: string[], input: OAuthRequest): string {
  const url = new URL(`https://www.facebook.com/${version(input.env, 'META_API_VERSION', 'v26.0')}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: envValue(input.env, 'META_APP_ID'),
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: scopes.join(','),
    state: input.state,
  }).toString();
  return url.toString();
}

async function metaExchange(input: OAuthExchange): Promise<Credential> {
  // Meta documents GET token exchanges. Never log these URLs: they contain server-only secrets.
  const initialUrl = metaUrl('oauth/access_token', input.env, {
    client_id: envValue(input.env, 'META_APP_ID'),
    client_secret: envValue(input.env, 'META_APP_SECRET'),
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  const initial = tokenResponse(await fetchJson('Meta', initialUrl.toString()));
  const extendUrl = metaUrl('oauth/access_token', input.env, {
    grant_type: 'fb_exchange_token',
    client_id: envValue(input.env, 'META_APP_ID'),
    client_secret: envValue(input.env, 'META_APP_SECRET'),
    fb_exchange_token: initial.accessToken,
  });
  return tokenResponse(await fetchJson('Meta', extendUrl.toString()));
}

function profile(body: JsonObject, name: string): { accountId: string; accountName: string } {
  if (typeof body.id !== 'string' || !body.id) throw new ProviderError(`${name} returned an invalid account profile.`, 502);
  return {
    accountId: body.id,
    accountName: typeof body.name === 'string' && body.name ? body.name : typeof body.username === 'string' ? body.username : `${name} account`,
  };
}

function records(body: JsonObject, name: string): JsonObject[] {
  if (!Array.isArray(body.data)) throw new ProviderError(`${name} returned an invalid resource list.`, 502);
  return body.data.filter(isObject).slice(0, 100);
}

function resources(body: JsonObject, name: string, type: string): Resource[] {
  return records(body, name).filter((record) => typeof record.id === 'string' && record.id).map((record) => ({
    id: String(record.id),
    name: typeof record.name === 'string' && record.name ? record.name : String(record.id),
    type,
  }));
}

async function facebookVerify(credential: Credential, env: NodeJS.ProcessEnv): Promise<VerifiedAccount> {
  const [me, pages] = await Promise.all([
    metaRead('Facebook', 'me', credential, env, { fields: 'id,name' }),
    metaRead('Facebook', 'me/accounts', credential, env, { fields: 'id,name', limit: '100' }),
  ]);
  return { ...profile(me, 'Facebook'), resources: resources(pages, 'Facebook', 'page') };
}

async function instagramVerify(credential: Credential, env: NodeJS.ProcessEnv): Promise<VerifiedAccount> {
  const [me, pages] = await Promise.all([
    metaRead('Instagram', 'me', credential, env, { fields: 'id,name' }),
    metaRead('Instagram', 'me/accounts', credential, env, { fields: 'id,name,instagram_business_account{id,username,name}', limit: '100' }),
  ]);
  const profiles = records(pages, 'Instagram').flatMap((page): Resource[] => {
    const account = page.instagram_business_account;
    if (!isObject(account) || typeof account.id !== 'string' || !account.id) return [];
    const label = typeof account.username === 'string' ? `@${account.username}` : typeof account.name === 'string' ? account.name : account.id;
    return [{ id: account.id, name: label, type: 'instagram-account' }];
  });
  const uniqueProfiles = [...new Map(profiles.map((item) => [item.id, item])).values()];
  if (!uniqueProfiles.length) {
    throw new ProviderError('No Instagram professional account was found. Link a business or creator Instagram account to a Facebook Page and grant access to that Page.');
  }
  return { ...profile(me, 'Instagram'), resources: uniqueProfiles };
}

async function businessVerify(credential: Credential, env: NodeJS.ProcessEnv): Promise<VerifiedAccount> {
  const [me, businesses, adAccounts] = await Promise.all([
    metaRead('Meta Business Manager', 'me', credential, env, { fields: 'id,name' }),
    metaRead('Meta Business Manager', 'me/businesses', credential, env, { fields: 'id,name', limit: '100' }),
    metaRead('Meta Business Manager', 'me/adaccounts', credential, env, { fields: 'id,name', limit: '100' }),
  ]);
  return {
    ...profile(me, 'Meta Business Manager'),
    resources: [...resources(businesses, 'Meta Business Manager', 'business'), ...resources(adAccounts, 'Meta Business Manager', 'ad-account')],
  };
}

function threadsUrl(path: string, env: NodeJS.ProcessEnv, params: Record<string, string> = {}): URL {
  const url = new URL(`https://graph.threads.com/${version(env, 'THREADS_API_VERSION', 'v1.0')}/${path}`);
  url.search = new URLSearchParams(params).toString();
  return url;
}

function threadsAuthorize(input: OAuthRequest): string {
  const redirect = new URL(input.redirectUri);
  if (redirect.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)) {
    throw new ProviderError('Threads requires an HTTPS callback on a registered non-localhost domain. Set APP_ORIGIN to that domain.');
  }
  const url = new URL('https://www.threads.com/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: envValue(input.env, 'THREADS_APP_ID'),
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: 'threads_basic,threads_content_publish,threads_read_replies,threads_manage_replies,threads_manage_insights',
    state: input.state,
  }).toString();
  return url.toString();
}

async function threadsExchange(input: OAuthExchange): Promise<Credential> {
  const form = new URLSearchParams({
    client_id: envValue(input.env, 'THREADS_APP_ID'),
    client_secret: envValue(input.env, 'THREADS_APP_SECRET'),
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  const initial = tokenResponse(await fetchJson('Threads', threadsUrl('oauth/access_token', input.env).toString(), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  }, threadsHttpOptions('code-exchange')));
  const url = threadsUrl('access_token', input.env, {
    grant_type: 'th_exchange_token',
    client_secret: envValue(input.env, 'THREADS_APP_SECRET'),
    access_token: initial.accessToken,
  });
  return tokenResponse(await fetchJson('Threads', url.toString(), {}, threadsHttpOptions('token-extension')));
}

async function threadsRefresh(credential: Credential, env: NodeJS.ProcessEnv): Promise<Credential> {
  if (credential.expiresAt && credential.expiresAt <= Date.now()) {
    throw new ProviderError('Threads access has expired. Reconnect this account.', 401);
  }
  const url = threadsUrl('refresh_access_token', env, { grant_type: 'th_refresh_token', access_token: safeCredential(credential) });
  return tokenResponse(await fetchJson('Threads', url.toString(), {}, threadsHttpOptions('token-refresh')), credential);
}

async function threadsVerify(credential: Credential, env: NodeJS.ProcessEnv): Promise<VerifiedAccount> {
  const url = threadsUrl('me', env, { fields: 'id,username,name', access_token: safeCredential(credential) });
  const body = await fetchJson('Threads', url.toString(), {}, threadsHttpOptions('profile-verification'));
  const account = profile(body, 'Threads');
  return { ...account, resources: [{ id: account.accountId, name: typeof body.username === 'string' ? `@${body.username}` : account.accountName, type: 'threads-profile' }] };
}

export const metaAdapters: ProviderAdapter[] = [
  {
    definition: { id: 'facebook', name: 'Facebook', category: 'social', authType: 'oauth', description: 'Connect Facebook and verify the Pages you can access.', docsUrl: 'https://developers.facebook.com/docs/pages-api/getting-started/' },
    requiredEnv: ['META_APP_ID', 'META_APP_SECRET'],
    authorize: (input) => metaAuthorize(['pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_posts', 'pages_manage_engagement', 'pages_messaging', 'read_insights'], input), exchange: metaExchange, verify: facebookVerify,
  },
  {
    definition: { id: 'instagram', name: 'Instagram', category: 'social', authType: 'oauth', description: 'Connect business or creator accounts linked to Facebook Pages.', docsUrl: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/' },
    requiredEnv: ['META_APP_ID', 'META_APP_SECRET'],
    authorize: (input) => metaAuthorize(['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights', 'instagram_manage_messages'], input), exchange: metaExchange, verify: instagramVerify,
  },
  {
    definition: { id: 'threads', name: 'Threads', category: 'social', authType: 'oauth', description: 'Connect and verify your Threads profile using Threads Login.', docsUrl: 'https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions/' },
    requiredEnv: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
    authorize: threadsAuthorize, exchange: threadsExchange, refresh: threadsRefresh, verify: threadsVerify,
  },
  {
    definition: { id: 'meta-business', name: 'Meta Business Manager', category: 'advertising', authType: 'oauth', description: 'Verify accessible business portfolios and ad accounts.', docsUrl: 'https://developers.facebook.com/docs/marketing-api/business-manager/' },
    requiredEnv: ['META_APP_ID', 'META_APP_SECRET'],
    authorize: (input) => metaAuthorize(['business_management', 'ads_read', 'ads_management', 'pages_read_engagement', 'pages_manage_ads'], input), exchange: metaExchange, verify: businessVerify,
  },
];
