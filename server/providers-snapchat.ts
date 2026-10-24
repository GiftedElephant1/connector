import { fetchJson, isObject, safeCredential, tokenResponse } from './provider-http';
import { ProviderError, type Credential, type ProviderAdapter, type Resource } from './provider-types';

export const snapchatApi = 'https://businessapi.snapchat.com';
const tokenUrl = 'https://accounts.snapchat.com/login/oauth2/access_token';

function setting(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value || /[\r\n\0]/.test(value)) throw new ProviderError(`Configure ${key} before connecting Snapchat.`, 503);
  return value;
}
export function snapchatUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ProviderError(`${label} must be a Snapchat UUID, without a URL or path.`);
  }
  return value.toLowerCase();
}
export function snapchatSuccess(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new ProviderError('Snapchat returned an unexpected response. Check Snapchat before retrying a publication.', 502);
  if (value.request_status !== 'SUCCESS') {
    if (value.error_code === 'MEDIA_POSTING_ALREADY_IN_PROGRESS') throw new ProviderError('Snapchat is already processing this media. Check the Public Profile before submitting another publication.', 502);
    if (value.error_code === 'MEDIA_EXPIRED') throw new ProviderError('Snapchat media expired before publication. Check the profile before uploading and posting again.', 400);
    throw new ProviderError('Snapchat rejected or only partially completed the request. Check Public Profile API approval, account permissions, and Snapchat before retrying a publication.', value.request_status === 'ERROR' ? 403 : 502);
  }
  return value;
}
export function snapchatProfiles(value: unknown): Resource[] {
  if (!Array.isArray(value) || !value.every(isObject)) throw new ProviderError('Snapchat returned an unexpected Public Profile list.', 502);
  return value.slice(0, 100).map(row => {
    if (row.sub_request_status !== 'SUCCESS' || !isObject(row.public_profile)) throw new ProviderError('Snapchat did not confirm access to every returned Public Profile.', 403);
    return snapchatProfile(row.public_profile);
  });
}
export function snapchatProfile(profile: Record<string, unknown>): Resource {
  const id = snapchatUuid(profile.id, 'Public Profile ID');
  const name = typeof profile.display_name === 'string' && profile.display_name.trim() ? profile.display_name.trim().slice(0, 300) : `Snapchat profile ${id}`;
  return { id, name, type: 'public_profile' };
}

async function token(env: NodeJS.ProcessEnv, fields: Record<string, string>, previous?: Credential): Promise<Credential> {
  const body = await fetchJson('Snapchat', tokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, client_id: setting(env, 'SNAPCHAT_CLIENT_ID'), client_secret: setting(env, 'SNAPCHAT_CLIENT_SECRET') }),
  });
  return tokenResponse(body, previous);
}

/** Public Profile API requires a separately allowlisted Business OAuth app, not Snap Kit. */
export const snapchatAdapter: ProviderAdapter = {
  definition: {
    id: 'snapchat', name: 'Snapchat', category: 'social', authType: 'oauth',
    description: 'Publish Public Profile Stories and Spotlight videos. Requires Snapchat Public Profile API allowlisting and posting permission.',
    docsUrl: 'https://developers.snap.com/marketing-api/Public-Profile-API/GetStarted',
  },
  requiredEnv: ['SNAPCHAT_CLIENT_ID', 'SNAPCHAT_CLIENT_SECRET'],
  authorize({ redirectUri, state, env }) {
    const query = new URLSearchParams({ response_type: 'code', client_id: setting(env, 'SNAPCHAT_CLIENT_ID'), redirect_uri: redirectUri, scope: 'snapchat-profile-api', state });
    return `https://accounts.snapchat.com/login/oauth2/authorize?${query}`;
  },
  exchange({ code, redirectUri, env }) { return token(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }); },
  refresh(previous, env) {
    if (!previous.refreshToken?.trim() || /[\r\n\0]/.test(previous.refreshToken)) throw new ProviderError('Snapchat access cannot be refreshed. Reconnect Snapchat.', 401);
    return token(env, { grant_type: 'refresh_token', refresh_token: previous.refreshToken }, previous);
  },
  async verify(credential, env) {
    const organization = env.SNAPCHAT_ORGANIZATION_ID?.trim();
    const path = organization
      ? `/v1/organizations/${snapchatUuid(organization, 'Snapchat organization ID')}/public_profiles?limit=100`
      : '/v1/public_profiles/my_profile';
    const body = snapchatSuccess(await fetchJson('Snapchat', `${snapchatApi}${path}`, { headers: { authorization: `Bearer ${safeCredential(credential)}` } }));
    if (organization) {
      const resources = snapchatProfiles(body.public_profiles);
      if (!resources.length) throw new ProviderError('No accessible Public Profiles were found in that Snapchat organization. Check your organization ID and profile role.', 403);
      return { accountName: 'Snapchat organization profiles', accountId: organization, resources };
    }
    if (!isObject(body.public_profile)) throw new ProviderError('Snapchat did not return your Public Profile. Create or authorize the intended Public Profile, or set its organization ID in setup.', 403);
    const resource = snapchatProfile(body.public_profile);
    return { accountName: resource.name, accountId: resource.id, resources: [resource] };
  },
};
