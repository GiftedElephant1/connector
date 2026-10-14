import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createApp, type ProviderService } from '../server/app';
import type { AppConfig } from '../server/config';
import { connectorResetPlan } from '../server/connector-reset';
import * as providers from '../server/providers';
import { Store } from '../server/store';
import { hydrateSettings, providerSettingKeys } from '../server/settings';
import { Pipeline } from '../server/pipeline';
import type { ActionAdapter } from '../server/action-types';

const account = { accountName: 'Fixture account', resources: [] };
const actualFetch = globalThis.fetch;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
};
async function fixture(t: TestContext, initialEnv: NodeJS.ProcessEnv = {}, overrides: Partial<ProviderService> = {}) {
  const config: AppConfig = { origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, password: 'reset-owner-password', encryptionKey: Buffer.alloc(32, 19), databasePath: ':memory:', secureCookies: false };
  const env = { ...initialEnv };
  const store = new Store(':memory:', config.encryptionKey);
  const app = createApp(config, store, { ...providers, verifyConnection: async () => account, ...overrides }, env);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = store.createSession();
  const cookie = `connector_session=${session}`;
  const request = (path: string, init: RequestInit = {}) => actualFetch(`${base}${path}`, { ...init, redirect: 'manual' });
  const mutate = (path: string, body: unknown = {}, method = 'POST') => request(path, { method, headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify(body) });
  const preview = (id: string) => request(`/api/connections/${id}/reset`, { headers: { cookie } });
  const reset = (id: string) => mutate(`/api/connections/${id}/reset`, { confirmed: true });
  return { config, env, store, session, cookie, request, mutate, preview, reset };
}

test('reset requires owner session, same-origin mutation header, explicit confirmation and a known provider', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/connections/linkedin/reset')).status, 401);
  assert.equal((await f.request('/api/connections/linkedin/reset', { method: 'POST', headers: { 'x-connector-request': '1' } })).status, 401);
  assert.equal((await f.request('/api/connections/linkedin/reset', { method: 'POST', headers: { cookie: f.cookie } })).status, 403);
  assert.equal((await f.mutate('/api/connections/linkedin/reset', {})).status, 409);
  assert.equal((await f.reset('unknown')).status, 404);
  assert.equal((await f.preview('unknown')).status, 404);
});

test('LinkedIn reset previews shared effects, cancels all pending work and masks .env values without changing unrelated setup', async t => {
  const initialEnv = { LINKEDIN_CLIENT_ID: 'wrong-app', LINKEDIN_CLIENT_SECRET: 'old-secret', LINKEDIN_API_VERSION: '202601', LINKEDIN_ENABLE_MEMBER_READ: 'true', LINKEDIN_ENABLE_CONVERSIONS: 'true', DISCORD_CLIENT_ID: 'keep-discord' };
  const f = await fixture(t, initialEnv);
  f.store.writeSetting('owner-password', { salt: 'fixture-salt', hash: 'preserve-owner-password-hash' });
  const ownerPassword = f.store.readSetting('owner-password');
  for (const id of ['linkedin', 'linkedin-ads', 'discord']) {
    f.store.save(id, { accessToken: `${id}-private-token` }, account);
    f.store.saveOAuth(`${id}-state`, f.session, id, 'old-verifier');
    f.store.createJob(`${id}-pending`, 'fixture', id, 'publish', {}, Date.now() + 100_000);
  }
  f.store.createJob('linkedin-completed', 'fixture', 'linkedin', 'publish', {}, Date.now());
  f.store.finishJob('linkedin-completed', 'succeeded', { summary: 'Already posted' });
  const response = await f.preview('linkedin');
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.deepEqual(plan.affectedProviders.map((provider: { id: string }) => provider.id).sort(), ['linkedin', 'linkedin-ads']);
  assert.equal(plan.pendingJobs, 2);
  assert.equal(plan.clearsGoogleWorkspace, false);
  assert.equal(JSON.stringify(plan).includes('old-secret'), false);
  assert.ok(f.store.credential('linkedin'), 'preview is read-only');
  assert.equal((await f.reset('linkedin')).status, 200);
  for (const id of ['linkedin', 'linkedin-ads']) {
    assert.equal(f.store.connection(id), null);
    assert.equal(f.store.credential(id), null);
    assert.equal(f.store.takeOAuth(`${id}-state`, f.session, id), null);
    assert.equal(f.store.job(`${id}-pending`)?.status, 'cancelled');
  }
  assert.equal(f.store.job('linkedin-completed')?.status, 'succeeded');
  assert.ok(f.store.credential('discord'));
  assert.equal(f.store.job('discord-pending')?.status, 'pending');
  assert.deepEqual(f.store.readSetting('owner-password'), ownerPassword);
  assert.equal(f.config.origin, 'http://127.0.0.1:3000');
  const restartedEnv: NodeJS.ProcessEnv = { ...initialEnv };
  hydrateSettings(f.config, f.store, restartedEnv);
  for (const key of new Set([...providerSettingKeys('linkedin'), ...providerSettingKeys('linkedin-ads')])) {
    assert.equal(f.env[key], '');
    assert.equal(restartedEnv[key], '', `${key} must not return from .env after restart`);
  }
  assert.equal(restartedEnv.DISCORD_CLIENT_ID, 'keep-discord');
  assert.equal((await f.mutate('/api/oauth/linkedin/start')).status, 400);
  assert.equal((await f.mutate('/api/settings', { values: { LINKEDIN_CLIENT_ID: 'correct-app', LINKEDIN_CLIENT_SECRET: 'correct-secret' } }, 'PUT')).status, 200);
  const started = await (await f.mutate('/api/oauth/linkedin/start')).json();
  assert.equal(new URL(started.url).searchParams.get('client_id'), 'correct-app');
});

test('every catalog connector has a reset plan and shared groups are complete', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 10));
  t.after(() => store.close());
  for (const provider of providers.providerCatalog) {
    const plan = connectorResetPlan(store, providers.providerCatalog, provider.id);
    assert.ok(plan.affectedProviders.some(entry => entry.id === provider.id));
    for (const selected of plan.affectedProviders) {
      const keys = providerSettingKeys(selected.id);
      for (const sibling of providers.providerCatalog.filter(candidate => providerSettingKeys(candidate.id).some(key => keys.includes(key)))) {
        assert.ok(plan.affectedProviders.some(entry => entry.id === sibling.id), `${provider.id} must include ${sibling.id}`);
      }
    }
  }
  const google = connectorResetPlan(store, providers.providerCatalog, 'google-workspace');
  assert.equal(google.clearsGoogleWorkspace, true);
  assert.deepEqual(google.affectedProviders.map(entry => entry.id).sort(), ['google-ads', 'google-analytics', 'google-workspace', 'search-console', 'youtube']);
});

test('API key, local vault and legacy AI resets remove stored credentials independently', async t => {
  const f = await fixture(t, { XAI_MODEL: 'old-model' });
  for (const id of ['mailchimp', 'obsidian', 'wordpress-self-hosted', 'openai', 'anthropic', 'xai']) {
    f.store.save(id, { accessToken: 'private', fields: { path: 'private-vault', site: 'https://private.example' } }, account);
    assert.equal((await f.reset(id)).status, 200);
    assert.equal(f.store.credential(id), null);
    assert.equal(f.store.connection(id), null);
  }
  assert.equal(f.env.XAI_MODEL, '');
});

test('Google setup reset clears shared platforms, all Workspace accounts, Maps keys and agent bindings', async t => {
  const f = await fixture(t, { GOOGLE_CLIENT_ID: 'old-client', GOOGLE_CLIENT_SECRET: 'old-secret', GOOGLE_ADS_DEVELOPER_TOKEN: 'old-ads-token' });
  const storedAccounts = ['work', 'personal'].map(id => ({ id, email: `${id}@example.com`, name: id, requestedApps: ['drive'], scopes: ['openid', 'email'], connectedAt: new Date().toISOString() }));
  f.store.writeSetting('workspace.accounts.v1', storedAccounts);
  f.store.writeSetting('workspace.profiles.v1', [{ id: 'agent', name: 'Preserve agent', keyHash: 'preserve-profile-key', bindings: storedAccounts.map(account => ({ accountId: account.id, apps: ['drive', 'maps'] })), defaultAccountId: 'work', createdAt: new Date().toISOString() }]);
  for (const provider of ['youtube', 'google-ads', 'google-analytics', 'search-console', 'google-workspace:work', 'google-workspace:personal', 'discord']) {
    f.store.save(provider, { accessToken: 'old-token', fields: { mapsApiKey: 'old-maps-key' } }, account);
    f.store.createJob(`${provider}-pending`, 'fixture', provider, 'publish', {}, Date.now() + 100_000);
  }
  f.store.saveOAuth('old-google-flow', f.session, 'google-workspace', 'old-verifier');
  const plan = await (await f.preview('google-workspace')).json();
  assert.equal(plan.pendingJobs, 6);
  assert.equal(plan.clearsGoogleWorkspace, true);
  assert.equal((await f.reset('google-workspace')).status, 200);
  for (const provider of ['youtube', 'google-ads', 'google-analytics', 'search-console', 'google-workspace:work', 'google-workspace:personal']) {
    assert.equal(f.store.credential(provider), null);
    assert.equal(f.store.job(`${provider}-pending`)?.status, 'cancelled');
  }
  assert.equal(f.store.readSetting('workspace.accounts.v1'), null);
  const profile = f.store.readSetting<any[]>('workspace.profiles.v1')![0];
  assert.equal(profile.keyHash, 'preserve-profile-key');
  assert.deepEqual(profile.bindings, []);
  assert.equal(profile.defaultAccountId, undefined);
  assert.equal(f.store.takeOAuth('old-google-flow', f.session, 'google-workspace'), null);
  assert.ok(f.store.credential('discord'));
  assert.equal(f.env.GOOGLE_CLIENT_ID, '');
  assert.equal(f.env.GOOGLE_ADS_DEVELOPER_TOKEN, '');
});

test('TikTok reset removes app-specific domain verification while preserving operator policies', async t => {
  const f = await fixture(t, { TIKTOK_CLIENT_KEY: 'old-key', TIKTOK_CLIENT_SECRET: 'old-secret' });
  f.store.writeSetting('tiktok-domain-verification-v1', { filename: 'tiktokold.txt', content: 'old-proof' });
  f.store.writeSetting('legal-profile-v1', { operatorName: 'Keep operator' });
  assert.equal((await f.reset('tiktok')).status, 200);
  assert.equal(f.store.readSetting('tiktok-domain-verification-v1'), null);
  assert.deepEqual(f.store.readSetting('legal-profile-v1'), { operatorName: 'Keep operator' });
});

test('Meta and Threads resets clear legacy version overrides without affecting the independent WhatsApp connector', async t => {
  const initialEnv = { META_APP_ID: 'old-app', META_APP_SECRET: 'old-secret', META_API_VERSION: 'v999.0', THREADS_APP_ID: 'threads-app', THREADS_APP_SECRET: 'threads-secret', THREADS_API_VERSION: 'v999.0' };
  const f = await fixture(t, initialEnv);
  f.store.save('whatsapp', { accessToken: 'keep-whatsapp', fields: { phoneNumberId: '123' } }, account);
  const plan = await (await f.preview('facebook')).json();
  assert.deepEqual(plan.affectedProviders.map((provider: { id: string }) => provider.id).sort(), ['facebook', 'instagram', 'meta-business']);
  assert.equal((await f.reset('facebook')).status, 200);
  assert.equal(f.env.META_API_VERSION, '');
  assert.equal(f.env.THREADS_API_VERSION, 'v999.0');
  assert.equal((await f.reset('threads')).status, 200);
  const restartedEnv = { ...initialEnv };
  hydrateSettings(f.config, f.store, restartedEnv);
  assert.equal(restartedEnv.META_API_VERSION, '');
  assert.equal(restartedEnv.THREADS_API_VERSION, '');
  assert.equal(f.store.credential('whatsapp')?.accessToken, 'keep-whatsapp');
});

test('reset preview counts more than the dashboard history limit and cancels every pending job', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 125; index++) f.store.createJob(`job-${index}`, 'fixture', 'mailchimp', 'publish', {}, Date.now() + 100_000);
  assert.equal((await (await f.preview('mailchimp')).json()).pendingJobs, 125);
  assert.equal((await f.reset('mailchimp')).status, 200);
  for (let index = 0; index < 125; index++) assert.equal(f.store.job(`job-${index}`)?.status, 'cancelled');
});

for (const operation of ['api-key', 'verify', 'refresh', 'oauth-exchange', 'oauth-verify']) {
  test(`reset blocks a late ${operation} response from restoring or replacing credentials`, async t => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const pause = async () => { entered.resolve(); await release.promise; };
    const provider = operation === 'api-key' ? 'mailchimp' : 'linkedin';
    let verifyCalls = 0;
    const f = await fixture(t, { LINKEDIN_CLIENT_ID: 'app', LINKEDIN_CLIENT_SECRET: 'secret' }, {
      exchangeOAuthCode: async () => { if (operation === 'oauth-exchange') await pause(); return { accessToken: 'stale-oauth-token' }; },
      verifyConnection: async () => { verifyCalls++; if (['api-key', 'verify', 'oauth-verify'].includes(operation)) await pause(); return account; },
      refreshCredential: async () => { await pause(); return { accessToken: 'stale-refreshed-token' }; },
    });
    f.store.save(provider, { accessToken: 'old-token', ...(operation === 'refresh' ? { expiresAt: 1 } : {}) }, account);
    let pending: Promise<Response>;
    if (operation.startsWith('oauth-')) {
      f.store.saveOAuth('old-oauth-state', f.session, provider, 'verifier');
      pending = f.request('/api/oauth/linkedin/callback?state=old-oauth-state&code=old-code', { headers: { cookie: f.cookie } });
    } else pending = f.mutate(`/api/connections/${provider}/${operation === 'api-key' ? 'api-key' : 'verify'}`, { apiKey: 'stale-api-key' });
    await entered.promise;
    assert.equal((await f.reset(provider)).status, 200);
    // A brand new successful connection must also survive the late old request.
    f.store.save(provider, { accessToken: 'new-connection-token' }, account);
    release.resolve();
    const result = await pending;
    if (operation.startsWith('oauth-')) {
      assert.equal(result.status, 302);
      assert.match(decodeURIComponent(result.headers.get('location')!), /disconnected or reset/);
    } else assert.equal(result.status, 409);
    assert.equal(f.store.credential(provider)?.accessToken, 'new-connection-token');
    assert.equal(f.store.connection(provider)?.status, 'connected');
    if (operation === 'oauth-exchange' || operation === 'refresh') assert.equal(verifyCalls, 0);
  });
}

test('reset prevents a pipeline refresh from issuing an action or overwriting a new connection', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 22));
  t.after(() => store.close());
  store.save('linkedin', { accessToken: 'expired', expiresAt: 1 }, account);
  const released = deferred<void>();
  let actions = 0;
  const adapter: ActionAdapter = { provider: 'linkedin', definition: { id: 'read', label: 'Read', description: '', kind: 'read', group: 'analytics', fields: [] }, execute: async () => { actions++; return { summary: 'Read' }; } };
  const pipeline = new Pipeline(store, {}, { getAction: () => adapter, listActions: () => [adapter.definition], validateValues: () => ({}) }, { refreshCredential: async () => { await released.promise; return { accessToken: 'stale-token' }; } });
  const pending = pipeline.run('linkedin', 'read', {}, false);
  store.disconnect('linkedin');
  store.save('linkedin', { accessToken: 'new-token' }, account);
  released.resolve();
  await assert.rejects(pending, /disconnected or reset/);
  assert.equal(actions, 0);
  assert.equal(store.credential('linkedin')?.accessToken, 'new-token');
});

test('Plaid reset clears stale credentials and Link authorization even when remote revocation fails', async t => {
  const f = await fixture(t, { PLAID_CLIENT_ID: 'mistaken-client', PLAID_SECRET: 'secret', PLAID_ENV: 'sandbox' });
  f.store.save('plaid', { accessToken: 'old-token', fields: { plaidClientId: 'original-client', plaidEnvironment: 'sandbox', plaidItemId: 'item' } }, account);
  f.store.saveOAuth('old-link-flow', f.session, 'plaid-link', 'binding');
  const response = await f.reset('plaid');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.match(body.warnings[0], /disabled locally/);
  assert.equal(f.store.credential('plaid'), null);
  assert.equal(f.store.takeOAuth('old-link-flow', f.session, 'plaid-link'), null);
  assert.equal(f.env.PLAID_CLIENT_ID, '');
  assert.equal(f.env.PLAID_SECRET, '');
  assert.equal(JSON.stringify(body).includes('old-token'), false);
});

for (const phase of ['link-token', 'exchange', 'verify']) {
  test(`Plaid reset blocks an in-flight ${phase} from restoring a connection, including failed remote cleanup`, async t => {
    const f = await fixture(t, { PLAID_CLIENT_ID: 'plaid-client', PLAID_SECRET: 'plaid-secret', PLAID_ENV: 'sandbox' });
    const entered = deferred<void>();
    const release = deferred<void>();
    let removals = 0;
    let verifies = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if ((phase === 'link-token' && path === '/link/token/create') || (phase === 'exchange' && path === '/item/public_token/exchange') || (phase === 'verify' && path === '/accounts/get')) { entered.resolve(); await release.promise; }
      if (path === '/link/token/create') return Response.json({ link_token: 'link-fixture', expiration: new Date(Date.now() + 100_000).toISOString() });
      if (path === '/item/public_token/exchange') return Response.json({ access_token: 'late-plaid-token', item_id: 'fixture-item' });
      if (path === '/accounts/get') { verifies++; return Response.json({ item: { item_id: 'fixture-item' }, accounts: [] }); }
      if (path === '/item/remove') { removals++; return Response.json({ error_code: 'INVALID_ACCESS_TOKEN' }, { status: 400 }); }
      throw new Error('Unexpected Plaid request');
    });
    let pending: Promise<Response>;
    if (phase === 'link-token') pending = f.mutate('/api/plaid/link-token');
    else {
      const flow = await (await f.mutate('/api/plaid/link-token')).json();
      pending = f.mutate('/api/plaid/exchange', { flowId: flow.flowId, publicToken: 'public-fixture-token' });
    }
    await entered.promise;
    const reset = await f.reset('plaid');
    assert.equal(reset.status, 200);
    const resetResult = await reset.json();
    if (phase === 'link-token') assert.equal(resetResult.warnings, undefined);
    else assert.match(resetResult.warnings[0], /authorization was still finishing/);
    release.resolve();
    const late = await pending;
    assert.equal(late.status, 409);
    if (phase !== 'link-token') assert.match((await late.json()).error, /did not confirm revoking/);
    assert.equal(f.store.credential('plaid'), null);
    assert.equal(f.store.connection('plaid'), null);
    if (phase === 'exchange') assert.equal(verifies, 0);
    assert.equal(removals, phase === 'link-token' ? 0 : 1);
  });
}
