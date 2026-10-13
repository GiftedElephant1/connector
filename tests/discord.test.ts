import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createOAuthRequest, exchangeOAuthCode, getProviderSetup, refreshCredential, verifyConnection } from '../server/providers.ts';
import { fetchJson, fetchJsonArray } from '../server/provider-http.ts';
import { ProviderError } from '../server/provider-types.ts';

const originalFetch = globalThis.fetch;
const env = { DISCORD_CLIENT_ID: 'test-client', DISCORD_CLIENT_SECRET: 'test-client-secret' };
afterEach(() => { globalThis.fetch = originalFetch; });

test('Discord OAuth requests only profile and server membership access with state', () => {
  const url = new URL(createOAuthRequest('discord', { env, state: 'session-specific-state', codeVerifier: 'test-verifier', redirectUri: 'https://connector.example/api/oauth/discord/callback' }));
  assert.equal(url.origin, 'https://discord.com');
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('scope'), 'identify guilds');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'session-specific-state');
  assert.equal(url.searchParams.get('client_id'), 'test-client');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(url.searchParams.has('permissions'), false);
  assert.equal(url.searchParams.has('integration_type'), false);
});

test('Discord app requirements are shown without credential values', () => {
  assert.deepEqual(getProviderSetup('discord', {}), { configured: false, missing: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'] });
  assert.deepEqual(getProviderSetup('discord', env), { configured: true, missing: [] });
});

test('Discord authorization code is exchanged with server-side form credentials', async () => {
  const before = Date.now();
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://discord.com/api/oauth2/token');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('client_id'), 'test-client');
    assert.equal(body.get('client_secret'), 'test-client-secret');
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'test-code');
    assert.equal(body.get('redirect_uri'), 'https://connector.example/api/oauth/discord/callback');
    return Response.json({ access_token: 'access-one', refresh_token: 'refresh-one', expires_in: 604800, token_type: 'Bearer' });
  };
  const credential = await exchangeOAuthCode('discord', { env, code: 'test-code', codeVerifier: 'test-verifier', redirectUri: 'https://connector.example/api/oauth/discord/callback' });
  assert.equal(credential.accessToken, 'access-one');
  assert.equal(credential.refreshToken, 'refresh-one');
  assert.ok(credential.expiresAt && credential.expiresAt >= before + 604_800_000);
});

test('Discord refresh handles rotated refresh tokens and missing refresh tokens', async () => {
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests += 1;
    assert.equal(url, 'https://discord.com/api/oauth2/token');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'refresh-one');
    return Response.json({ access_token: 'access-two', refresh_token: 'refresh-two', expires_in: 604800 });
  };
  const credential = await refreshCredential('discord', { accessToken: 'access-one', refreshToken: 'refresh-one', expiresAt: Date.now() - 1 }, env);
  assert.equal(credential.accessToken, 'access-two');
  assert.equal(credential.refreshToken, 'refresh-two');
  await assert.rejects(refreshCredential('discord', { accessToken: 'access-one', expiresAt: Date.now() - 1 }, env), /Reconnect/);
  assert.equal(requests, 1);
});

test('Discord verifies profile and a bounded server list through GET only', async () => {
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push(String(url));
    assert.equal(init?.method, undefined);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer user-token');
    assert.ok(init?.signal);
    assert.equal(init?.redirect, 'error');
    if (String(url).endsWith('/users/@me')) return Response.json({ id: 'user-one', username: 'user_name', global_name: 'Display name', email: 'must-not-return@example.com' });
    assert.equal(url, 'https://discord.com/api/v10/users/@me/guilds?limit=100');
    return Response.json(Array.from({ length: 150 }, (_, index) => ({ id: `guild-${index}`, name: `Server ${index}`, permissions: '8' })));
  };
  const account = await verifyConnection('discord', { accessToken: 'user-token' }, env);
  assert.equal(account.accountId, 'user-one');
  assert.equal(account.accountName, 'Display name');
  assert.equal(account.resources.length, 100);
  assert.deepEqual(account.resources[0], { id: 'guild-0', name: 'Server 0', type: 'discord-server' });
  assert.equal(JSON.stringify(account).includes('must-not-return'), false);
  assert.equal(requests.length, 2);
});

test('Discord verifies users with no servers and falls back to their username', async () => {
  globalThis.fetch = async (url) => Response.json(String(url).endsWith('/users/@me') ? { id: 'user-one', username: 'user_name', global_name: null } : []);
  assert.deepEqual(await verifyConnection('discord', { accessToken: 'user-token' }, env), { accountId: 'user-one', accountName: 'user_name', resources: [] });
});

test('Discord malformed responses and upstream credential errors do not leak details', async () => {
  globalThis.fetch = async () => Response.json({ message: 'server-only-secret user-token' }, { status: 401 });
  await assert.rejects(verifyConnection('discord', { accessToken: 'user-token' }, env), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 401);
    assert.equal(error.message.includes('user-token'), false);
    assert.equal(error.message.includes('server-only-secret'), false);
    return true;
  });
  globalThis.fetch = async (url) => Response.json(String(url).endsWith('/users/@me') ? { username: 'invalid-profile' } : []);
  await assert.rejects(verifyConnection('discord', { accessToken: 'user-token' }, env), /invalid account profile/);
});

test('array response support preserves strict object and array endpoint validation', async () => {
  globalThis.fetch = async () => Response.json([]);
  await assert.rejects(fetchJson('Discord', 'https://discord.com/api/v10/users/@me'), /invalid response/);
  globalThis.fetch = async () => Response.json({ error: 'not-an-array' });
  await assert.rejects(fetchJsonArray('Discord', 'https://discord.com/api/v10/users/@me/guilds'), /invalid response/);
  globalThis.fetch = async () => Response.json([null]);
  await assert.rejects(fetchJsonArray('Discord', 'https://discord.com/api/v10/users/@me/guilds'), /invalid response/);
});
