import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../server/app';
import type { AppConfig } from '../server/config';
import { McpOAuth } from '../server/mcp-oauth';
import { Store } from '../server/store';
import { WorkspaceAccounts } from '../server/workspace-accounts';

test('retired Plaid stays inaccessible without resetting saved accounts, agent access or scheduled work', async t => {
  const originalFetch = globalThis.fetch;
  const store = new Store(':memory:', Buffer.alloc(32, 37));
  const config: AppConfig = { origin: 'https://connector.example', host: '127.0.0.1', port: 3000, password: 'fixture-owner-password', encryptionKey: Buffer.alloc(32, 37), databasePath: ':memory:', secureCookies: true, pipelineKey: 'e'.repeat(43) };
  const generalKey = 'p'.repeat(43);
  const env: NodeJS.ProcessEnv = { PLAID_CLIENT_ID: 'retired-client', PLAID_SECRET: 'retired-secret', PLAID_ENV: 'sandbox' };
  const credentials = {
    facebook: { accessToken: 'keep-facebook-token' },
    linkedin: { accessToken: 'keep-linkedin-token', refreshToken: 'keep-linkedin-refresh' },
    discord: { accessToken: 'keep-discord-token' },
    'google-workspace:work': { accessToken: 'keep-google-token', refreshToken: 'keep-google-refresh', fields: { mapsApiKey: 'keep-maps-key' } },
    plaid: { accessToken: 'retired-bank-token', fields: { plaidItemId: 'retired-item', plaidClientId: 'retired-client', plaidEnvironment: 'sandbox' } },
  };
  const summaries = Object.fromEntries(Object.entries(credentials).map(([id, credential]) => [id, store.save(id, credential, { accountId: id, accountName: `${id} account`, resources: [] })]));
  const overrides = { DISCORD_CLIENT_ID: 'keep-discord-app', DISCORD_CLIENT_SECRET: 'keep-discord-secret', GOOGLE_CLIENT_ID: 'keep-google-client', GOOGLE_CLIENT_SECRET: 'keep-google-secret', PLAID_CLIENT_ID: 'retired-client', PLAID_SECRET: 'retired-secret' };
  store.writeSetting('provider-overrides', overrides);
  store.writeSetting('pipeline-key-override', generalKey);
  store.writeSetting('public-tunnel', { domain: 'keep.ngrok.app', authtoken: 'keep-tunnel-key', autoStart: false });
  store.writeSetting('workspace.accounts.v1', [{ id: 'work', email: 'grok@example.com', name: 'Work account', requestedApps: ['sheets'], scopes: ['https://www.googleapis.com/auth/spreadsheets'], connectedAt: new Date().toISOString() }]);
  const workspace = new WorkspaceAccounts(config, store, env);
  const agent = workspace.createProfile({ name: 'Existing Grok Bot', bindings: [{ accountId: 'work', apps: ['sheets'] }], defaultAccountId: 'work' });
  const session = store.createSession();
  store.saveOAuth('keep-provider-state', session, 'linkedin', 'keep-pkce-verifier');
  store.saveOAuth('retired-plaid-state', session, 'plaid-link', 'retired-link-binding');
  const job = store.createJob('keep-pending-job', 'keep-fingerprint', 'discord', 'publish-message', { channelId: '123456789012345678', content: 'Keep scheduled message' }, Date.now() + 86_400_000);

  const oauth = new McpOAuth(config, store, workspace);
  const client = oauth.register({ client_name: 'Existing Grok OAuth client', redirect_uris: ['https://ai.example/callback'] });
  const verifier = 'v'.repeat(64);
  const pending = new URL(oauth.start({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: oauth.resource() })).searchParams.get('authorize')!;
  oauth.consent(pending, session);
  const code = new URL(oauth.approve(pending, session, { approve: true, platforms: true, workspaceProfileId: agent.profile.id }).redirectUrl).searchParams.get('code')!;
  const tokens = oauth.token({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code, code_verifier: verifier, resource: oauth.resource() });
  const settingNames = ['provider-overrides', 'pipeline-key-override', 'public-tunnel', 'workspace.accounts.v1', 'workspace.profiles.v1', 'mcp.oauth.v1'];
  const savedSettings = Object.fromEntries(settingNames.map(name => [name, store.readSetting(name)]));

  let outgoingRequests = 0;
  globalThis.fetch = async () => { outgoingRequests++; throw new Error('No provider network request is allowed during Plaid retirement.'); };
  const server = createApp(config, store, undefined, env).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = `connector_session=${session}`;
  const request = (path: string, init: RequestInit = {}) => originalFetch(`${base}${path}`, { ...init, redirect: 'manual' });
  const mutate = (path: string, body: unknown, method = 'POST') => request(path, { method, headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify(body) });
  const api = (path: string, key = generalKey) => request(path, { headers: { authorization: `Bearer ${key}` } });
  let rpcId = 0;
  const rpc = async (name: string, args: unknown) => {
    const response = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200);
    return response.json();
  };

  for (const name of settingNames) assert.deepEqual(store.readSetting(name), savedSettings[name], `${name} must survive startup unchanged`);
  assert.equal(config.pipelineKey, generalKey, 'the saved general Connector key remains active');
  assert.equal(store.validSession(session), true);
  const providersResponse = await request('/api/providers', { headers: { cookie } });
  assert.equal(providersResponse.status, 200, 'the pre-existing owner session still works');
  const catalog = (await providersResponse.json()).providers;
  assert.equal(catalog.some((provider: { id: string }) => provider.id === 'plaid'), false);
  for (const id of ['facebook', 'linkedin', 'discord']) assert.deepEqual(catalog.find((provider: { id: string }) => provider.id === id).connection, summaries[id]);
  const settings = await (await request('/api/settings', { headers: { cookie } })).json();
  assert.equal(settings.fields.some((field: { key: string }) => field.key.startsWith('PLAID_')), false);
  assert.equal((await mutate('/api/settings', { values: { PLAID_SECRET: 'cannot-restore-retired-integration' } }, 'PUT')).status, 400);
  assert.deepEqual(store.readSetting('provider-overrides'), overrides, 'a rejected retired setting cannot change any saved provider setup');
  for (const path of ['/api/plaid/link-token', '/api/plaid/exchange', '/api/connections/plaid/verify', '/api/connections/plaid/reset', '/api/connections/plaid/api-key']) {
    assert.equal((await mutate(path, { confirmed: true, apiKey: 'unused' })).status, 404, path);
  }
  assert.equal((await request('/api/settings/providers/plaid', { headers: { cookie } })).status, 404);
  const connections = await (await api('/api/v1/connections')).json();
  assert.equal(connections.connections.some((connection: { provider: string }) => connection.provider === 'plaid'), false);
  assert.equal(connections.connections.find((connection: { provider: string }) => connection.provider === 'facebook').status, 'connected');
  for (const action of ['list-accounts', 'read-balances', 'read-transactions']) {
    const deniedAction = await request(`/api/v1/actions/plaid/${action}`, { method: 'POST', headers: { authorization: `Bearer ${generalKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ values: {} }) });
    assert.equal(deniedAction.status, 404, `The former ${action} REST action must not execute.`);
    assert.equal((await rpc('run_action', { provider: 'plaid', action, values: {} })).result.isError, true, `The former ${action} MCP action must not execute.`);
  }
  const mcpConnections = await rpc('list_connections', {});
  assert.equal(mcpConnections.result.isError, undefined);
  assert.equal(mcpConnections.result.structuredContent.connections.some((connection: { provider: string }) => connection.provider === 'plaid'), false);
  const scopedAccounts = await (await api('/api/v1/workspace/accounts', agent.apiKey)).json();
  assert.equal(scopedAccounts.accounts[0].email, 'grok@example.com');
  const mcpAccounts = await rpc('list_workspace_accounts', {});
  assert.equal(mcpAccounts.result.structuredContent.accounts[0].email, 'grok@example.com');
  assert.deepEqual((await (await api('/api/v1/jobs')).json()).jobs, [job]);
  assert.deepEqual(store.jobValues(job.id), { channelId: '123456789012345678', content: 'Keep scheduled message' });
  for (const [id, credential] of Object.entries(credentials)) {
    assert.deepEqual(store.credential(id), credential, `${id} credentials remain encrypted and readable`);
    assert.deepEqual(store.connection(id), summaries[id]);
  }
  for (const name of settingNames.filter(name => name !== 'mcp.oauth.v1')) assert.deepEqual(store.readSetting(name), savedSettings[name]);
  const renewed = oauth.token({ client_id: client.client_id, grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  assert.equal(oauth.authenticate(renewed.access_token)?.workspaceProfileId, agent.profile.id, 'existing MCP refresh grants still authorize the same profile');
  assert.deepEqual(store.takeOAuth('keep-provider-state', session, 'linkedin'), { verifier: 'keep-pkce-verifier' });
  assert.deepEqual(store.takeOAuth('retired-plaid-state', session, 'plaid-link'), { verifier: 'retired-link-binding' }, 'retirement performs no database cleanup or shared reset');
  assert.equal(outgoingRequests, 0);
});
