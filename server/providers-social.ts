import { createHash } from 'node:crypto';
import { fetchJson, isObject, safeCredential, tokenResponse, type JsonObject } from './provider-http.ts';
import { ProviderError, type Credential, type OAuthRequest, type ProviderAdapter, type VerifiedAccount } from './provider-types.ts';

function setting(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value?.trim() || /[\r\n]/.test(value)) throw new ProviderError(`Configure ${key} in the server environment first.`);
  return value.trim();
}

function authorization(endpoint: string, input: OAuthRequest, clientId: string, scope?: string, extra: Record<string, string> = {}): string {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: input.redirectUri,
    state: input.state, ...(scope ? { scope } : {}), ...extra,
  }).toString();
  return url.toString();
}

function basic(env: NodeJS.ProcessEnv, prefix: string): string {
  return `Basic ${Buffer.from(`${setting(env, `${prefix}_CLIENT_ID`)}:${setting(env, `${prefix}_CLIENT_SECRET`)}`).toString('base64')}`;
}

function bearer(credential: Credential): Record<string, string> {
  return { authorization: `Bearer ${safeCredential(credential)}` };
}

function refreshToken(credential: Credential): string {
  if (!credential.refreshToken) throw new ProviderError('This connection must be reconnected to renew access.');
  return safeCredential({ accessToken: credential.refreshToken });
}

function invalid(provider: string): never {
  throw new ProviderError(`${provider} did not return a valid account. Check permissions and reconnect.`, 502);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : text(value);
}

function profile(provider: string, accountId: unknown, accountName: unknown): VerifiedAccount {
  const normalizedId = id(accountId);
  const normalizedName = text(accountName);
  if (!normalizedId || !normalizedName) return invalid(provider);
  return {
    accountId: normalizedId, accountName: normalizedName,
    resources: [{ id: normalizedId, name: normalizedName, type: 'profile' }],
  };
}

/** Retain refresh rotation, returned scopes and refresh expiry without exposing tokens in errors. */
function credentials(body: JsonObject, previous?: Credential): Credential {
  if (body.error) throw new ProviderError('The provider could not authorize this connection. Check the app configuration and reconnect.', 400);
  const credential = tokenResponse(body, previous);
  safeCredential(credential);
  const fields = { ...previous?.fields };
  if (typeof body.scope === 'string') fields.scope = body.scope;
  if (typeof body.open_id === 'string') fields.openId = body.open_id;
  const refreshExpiresIn = Number(body.refresh_expires_in ?? body.refresh_token_expires_in);
  const refreshExpiresAt = Number(body.refresh_token_expires_at);
  if (Number.isFinite(refreshExpiresAt) && refreshExpiresAt > 0) fields.refreshExpiresAt = String(refreshExpiresAt * 1000);
  else if (Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0) fields.refreshExpiresAt = String(Date.now() + refreshExpiresIn * 1000);
  return {
    ...credential,
    ...(credential.tokenType ? {} : previous?.tokenType ? { tokenType: previous.tokenType } : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
  };
}

async function tokenRequest(provider: string, endpoint: string, values: Record<string, string>, headers: Record<string, string> = {}, previous?: Credential): Promise<Credential> {
  const body = await fetchJson(provider, endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(values),
  });
  return credentials(body, previous);
}

const x: ProviderAdapter = {
  definition: {
    id: 'x', name: 'X (Twitter)', category: 'social', authType: 'oauth',
    description: 'Verify your X profile through the official X API. Requires an X developer app and API access.',
    docsUrl: 'https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code',
  },
  requiredEnv: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
  authorize: (input) => authorization('https://x.com/i/oauth2/authorize', input, setting(input.env, 'X_CLIENT_ID'), 'tweet.read tweet.write users.read dm.read dm.write offline.access', {
    code_challenge: createHash('sha256').update(input.codeVerifier).digest('base64url'), code_challenge_method: 'S256',
  }),
  exchange: (input) => tokenRequest('X', 'https://api.x.com/2/oauth2/token', {
    grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
    client_id: setting(input.env, 'X_CLIENT_ID'), code_verifier: input.codeVerifier,
  }, { authorization: basic(input.env, 'X') }),
  refresh: (credential, env) => tokenRequest('X', 'https://api.x.com/2/oauth2/token', {
    grant_type: 'refresh_token', refresh_token: refreshToken(credential), client_id: setting(env, 'X_CLIENT_ID'),
  }, { authorization: basic(env, 'X') }, credential),
  verify: async (credential) => {
    const body = await fetchJson('X', 'https://api.x.com/2/users/me', { headers: bearer(credential) });
    if (!isObject(body.data) || body.errors) return invalid('X');
    return profile('X', body.data.id, text(body.data.username) ? `@${text(body.data.username)}` : body.data.name);
  },
};

const tiktok: ProviderAdapter = {
  definition: {
    id: 'tiktok', name: 'TikTok', category: 'social', authType: 'oauth',
    description: 'Verify your TikTok profile with Login Kit. Requires an approved TikTok developer application.',
    docsUrl: 'https://developers.tiktok.com/doc/login-kit-web',
  },
  requiredEnv: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
  authorize: (input) => {
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    url.search = new URLSearchParams({
      client_key: setting(input.env, 'TIKTOK_CLIENT_KEY'), response_type: 'code',
      scope: 'user.info.basic,video.publish,video.list', redirect_uri: input.redirectUri, state: input.state,
    }).toString();
    return url.toString();
  },
  exchange: (input) => tokenRequest('TikTok', 'https://open.tiktokapis.com/v2/oauth/token/', {
    client_key: setting(input.env, 'TIKTOK_CLIENT_KEY'), client_secret: setting(input.env, 'TIKTOK_CLIENT_SECRET'),
    grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
  }),
  refresh: (credential, env) => tokenRequest('TikTok', 'https://open.tiktokapis.com/v2/oauth/token/', {
    client_key: setting(env, 'TIKTOK_CLIENT_KEY'), client_secret: setting(env, 'TIKTOK_CLIENT_SECRET'),
    grant_type: 'refresh_token', refresh_token: refreshToken(credential),
  }, {}, credential),
  verify: async (credential) => {
    const body = await fetchJson('TikTok', 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', { headers: bearer(credential) });
    if (!isObject(body.error) || body.error.code !== 'ok' || !isObject(body.data) || !isObject(body.data.user)) return invalid('TikTok');
    return profile('TikTok', body.data.user.open_id, body.data.user.display_name);
  },
};

const linkedin: ProviderAdapter = {
  definition: {
    id: 'linkedin', name: 'LinkedIn', category: 'social', authType: 'oauth',
    description: 'Verify your member profile with Sign In with LinkedIn using OpenID Connect.',
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2',
  },
  requiredEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  authorize: (input) => authorization('https://www.linkedin.com/oauth/v2/authorization', input, setting(input.env, 'LINKEDIN_CLIENT_ID'), `openid profile w_member_social${input.env.LINKEDIN_ENABLE_MEMBER_READ === 'true' ? ' r_member_social' : ''}`),
  exchange: (input) => tokenRequest('LinkedIn', 'https://www.linkedin.com/oauth/v2/accessToken', {
    grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
    client_id: setting(input.env, 'LINKEDIN_CLIENT_ID'), client_secret: setting(input.env, 'LINKEDIN_CLIENT_SECRET'),
  }),
  // LinkedIn issues refresh tokens only to eligible approved applications. Otherwise reconnect after expiry.
  refresh: (credential, env) => tokenRequest('LinkedIn', 'https://www.linkedin.com/oauth/v2/accessToken', {
    grant_type: 'refresh_token', refresh_token: refreshToken(credential),
    client_id: setting(env, 'LINKEDIN_CLIENT_ID'), client_secret: setting(env, 'LINKEDIN_CLIENT_SECRET'),
  }, {}, credential),
  verify: async (credential) => {
    const body = await fetchJson('LinkedIn', 'https://api.linkedin.com/v2/userinfo', { headers: bearer(credential) });
    return profile('LinkedIn', body.sub, body.name ?? [text(body.given_name), text(body.family_name)].filter(Boolean).join(' '));
  },
};

const reddit: ProviderAdapter = {
  definition: {
    id: 'reddit', name: 'Reddit', category: 'social', authType: 'oauth',
    description: 'Verify your Reddit identity using an approved Reddit web application.',
    docsUrl: 'https://github.com/reddit-archive/reddit/wiki/OAuth2',
  },
  requiredEnv: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'],
  authorize: (input) => authorization('https://www.reddit.com/api/v1/authorize', input, setting(input.env, 'REDDIT_CLIENT_ID'), 'identity read submit privatemessages', { duration: 'permanent' }),
  exchange: (input) => tokenRequest('Reddit', 'https://www.reddit.com/api/v1/access_token', {
    grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
  }, { authorization: basic(input.env, 'REDDIT'), 'user-agent': setting(input.env, 'REDDIT_USER_AGENT') }),
  refresh: (credential, env) => tokenRequest('Reddit', 'https://www.reddit.com/api/v1/access_token', {
    grant_type: 'refresh_token', refresh_token: refreshToken(credential),
  }, { authorization: basic(env, 'REDDIT'), 'user-agent': setting(env, 'REDDIT_USER_AGENT') }, credential),
  verify: async (credential, env) => {
    const body = await fetchJson('Reddit', 'https://oauth.reddit.com/api/v1/me', {
      headers: { ...bearer(credential), 'user-agent': setting(env, 'REDDIT_USER_AGENT') },
    });
    return profile('Reddit', body.id, text(body.name) ? `u/${text(body.name)}` : undefined);
  },
};

const pinterest: ProviderAdapter = {
  definition: {
    id: 'pinterest', name: 'Pinterest', category: 'social', authType: 'oauth',
    description: 'Verify your Pinterest account through API v5. Standard access may require app approval.',
    docsUrl: 'https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/',
  },
  requiredEnv: ['PINTEREST_CLIENT_ID', 'PINTEREST_CLIENT_SECRET'],
  authorize: (input) => authorization('https://www.pinterest.com/oauth/', input, setting(input.env, 'PINTEREST_CLIENT_ID'), 'user_accounts:read,boards:read,boards:write,pins:read,pins:write'),
  exchange: (input) => tokenRequest('Pinterest', 'https://api.pinterest.com/v5/oauth/token', {
    grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, continuous_refresh: 'true',
  }, { authorization: basic(input.env, 'PINTEREST') }),
  refresh: (credential, env) => tokenRequest('Pinterest', 'https://api.pinterest.com/v5/oauth/token', {
    grant_type: 'refresh_token', refresh_token: refreshToken(credential), continuous_refresh: 'true',
  }, { authorization: basic(env, 'PINTEREST') }, credential),
  verify: async (credential) => {
    const body = await fetchJson('Pinterest', 'https://api.pinterest.com/v5/user_account', { headers: bearer(credential) });
    if (!text(body.username)) return invalid('Pinterest');
    return profile('Pinterest', body.id ?? body.username, text(body.business_name) ?? body.username);
  },
};

const wordpress: ProviderAdapter = {
  definition: {
    id: 'wordpress', name: 'WordPress', category: 'websites', authType: 'oauth',
    description: 'Connect WordPress.com and eligible Jetpack-connected sites for posts, comments and available site statistics.',
    docsUrl: 'https://developer.wordpress.com/docs/oauth2/',
  },
  requiredEnv: ['WORDPRESS_CLIENT_ID', 'WORDPRESS_CLIENT_SECRET'],
  // Omit scope=global: WordPress defaults to a grant for the site chosen on its consent screen.
  authorize: (input) => authorization('https://public-api.wordpress.com/oauth2/authorize', input, setting(input.env, 'WORDPRESS_CLIENT_ID')),
  exchange: (input) => tokenRequest('WordPress', 'https://public-api.wordpress.com/oauth2/token', {
    grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
    client_id: setting(input.env, 'WORDPRESS_CLIENT_ID'), client_secret: setting(input.env, 'WORDPRESS_CLIENT_SECRET'),
  }),
  verify: async (credential) => {
    const headers = bearer(credential);
    const body = await fetchJson('WordPress', 'https://public-api.wordpress.com/rest/v1.1/me', { headers });
    const account = profile('WordPress', body.ID, text(body.display_name) ?? body.username);
    const sites = await fetchJson('WordPress', 'https://public-api.wordpress.com/rest/v1.1/me/sites', { headers });
    if (!Array.isArray(sites.sites)) return invalid('WordPress');
    return {
      ...account,
      resources: sites.sites.filter(isObject).filter((site) => id(site.ID)).slice(0, 100).map((site) => ({
        id: id(site.ID)!, name: text(site.name) ?? text(site.URL) ?? id(site.ID)!, type: 'site',
      })),
    };
  },
};

export const socialAdapters: ProviderAdapter[] = [x, tiktok, linkedin, reddit, pinterest, wordpress];
