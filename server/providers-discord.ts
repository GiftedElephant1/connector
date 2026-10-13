import { fetchJson, fetchJsonArray, safeCredential, tokenResponse } from './provider-http.ts';
import { ProviderError, type Credential, type OAuthExchange, type OAuthRequest, type ProviderAdapter, type VerifiedAccount } from './provider-types.ts';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ProviderError(`Set ${name} in the server configuration before connecting.`);
  return value;
}

function authorize(input: OAuthRequest): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: required(input.env, 'DISCORD_CLIENT_ID'),
    response_type: 'code',
    redirect_uri: input.redirectUri,
    state: input.state,
    scope: 'identify guilds',
  }).toString();
  return url.toString();
}

async function tokenRequest(env: NodeJS.ProcessEnv, params: Record<string, string>, previous?: Credential): Promise<Credential> {
  const form = new URLSearchParams({
    client_id: required(env, 'DISCORD_CLIENT_ID'),
    client_secret: required(env, 'DISCORD_CLIENT_SECRET'),
    ...params,
  });
  const body = await fetchJson('Discord', 'https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return tokenResponse(body, previous);
}

async function exchange(input: OAuthExchange): Promise<Credential> {
  return tokenRequest(input.env, { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri });
}

async function refresh(credential: Credential, env: NodeJS.ProcessEnv): Promise<Credential> {
  if (!credential.refreshToken) throw new ProviderError('Discord access has expired. Reconnect this account.', 401);
  return tokenRequest(env, { grant_type: 'refresh_token', refresh_token: credential.refreshToken }, credential);
}

async function verify(credential: Credential): Promise<VerifiedAccount> {
  const headers = { authorization: `Bearer ${safeCredential(credential)}` };
  const [user, guilds] = await Promise.all([
    fetchJson('Discord', 'https://discord.com/api/v10/users/@me', { headers }),
    fetchJsonArray('Discord', 'https://discord.com/api/v10/users/@me/guilds?limit=100', { headers }),
  ]);
  if (typeof user.id !== 'string' || !user.id || typeof user.username !== 'string') {
    throw new ProviderError('Discord returned an invalid account profile.', 502);
  }
  return {
    accountId: user.id,
    accountName: typeof user.global_name === 'string' && user.global_name ? user.global_name : user.username,
    resources: guilds.filter((guild) => typeof guild.id === 'string' && guild.id && typeof guild.name === 'string').map((guild) => ({
      id: String(guild.id), name: String(guild.name), type: 'discord-server',
    })),
  };
}

export const discordAdapters: ProviderAdapter[] = [{
  definition: {
    id: 'discord', name: 'Discord', category: 'communications', authType: 'oauth',
    description: 'Connect your Discord profile and verify server memberships.',
    docsUrl: 'https://docs.discord.com/developers/topics/oauth2',
  },
  requiredEnv: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'],
  authorize, exchange, refresh, verify,
}];
