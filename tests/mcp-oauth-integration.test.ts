import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ActionAdapter } from '../server/action-types.ts';
import { validateValues } from '../server/actions.ts';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { Pipeline } from '../server/pipeline.ts';
import { ProviderError, type Credential } from '../server/provider-types.ts';
import { Store } from '../server/store.ts';
import { WorkspaceAccounts } from '../server/workspace-accounts.ts';
import { workspaceApps } from '../server/workspace-actions.ts';

// These are protocol compatibility tests using the official MCP client SDK, not
// claims that a paid Claude, ChatGPT, or Grok account was exercised in CI.
const masterKey = 'test-independent-pipeline-key-1234567890';
const platformKey = 'private-platform-access-token';
type ClientMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

class MemoryOAuthClient implements OAuthClientProvider {
  readonly redirectUrl = 'https://mcp-client.example.test/oauth/callback';
  readonly stateValue = randomBytes(24).toString('base64url');
  readonly clientMetadata: OAuthClientMetadata;
  information?: OAuthClientInformationMixed;
  savedTokens?: OAuthTokens;
  authorizationUrl?: URL;
  verifier = '';
  constructor(method: ClientMethod = 'none') {
    this.clientMetadata = { client_name: `MCP SDK ${method} compatibility client`, redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  }
  state() { return this.stateValue; }
  clientInformation() { return this.information; }
  saveClientInformation(value: OAuthClientInformationMixed) { this.information = value; }
  tokens() { return this.savedTokens; }
  saveTokens(value: OAuthTokens) { this.savedTokens = value; }
  redirectToAuthorization(value: URL) { this.authorizationUrl = value; }
  saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() { return this.verifier; }
  invalidateCredentials(scope: string) {
    if (scope === 'all' || scope === 'tokens') this.savedTokens = undefined;
    if (scope === 'all' || scope === 'client') this.information = undefined;
    if (scope === 'all' || scope === 'verifier') this.verifier = '';
  }
}

async function fixture(t: TestContext, options: { execute?: ActionAdapter['execute']; refreshCredential?: (credential: Credential) => Promise<Credential> } = {}) {
  const config: AppConfig = { origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000,
    password: 'private-owner-password', encryptionKey: Buffer.alloc(32, 87), databasePath: ':memory:', secureCookies: false, pipelineKey: masterKey };
  const store = new Store(':memory:', config.encryptionKey);
  store.save('x', { accessToken: platformKey, ...(options.refreshCredential ? { expiresAt: Date.now() - 1_000 } : {}) }, { accountName: 'Social test account', resources: [] });
  const requestedApps = ['sheets', 'gmail'];
  const scopes = workspaceApps.filter(app => requestedApps.includes(app.id)).flatMap(app => app.scopes);
  store.writeSetting('workspace.accounts.v1', ['work', 'personal', 'hidden'].map(id => ({ id, email: `${id}@example.test`, name: id,
    requestedApps, scopes, connectedAt: new Date().toISOString() })));
  for (const id of ['work', 'personal', 'hidden']) store.save(`google-workspace:${id}`, { accessToken: `private-google-${id}` }, { accountId: id, accountName: `${id}@example.test`, resources: [] });
  const accounts = new WorkspaceAccounts(config, store, {});
  const work = accounts.createProfile({ name: 'Work assistant', bindings: [{ accountId: 'work', apps: ['sheets'] }], defaultAccountId: 'work' });
  const personal = accounts.createProfile({ name: 'Personal assistant', bindings: [{ accountId: 'personal', apps: ['gmail'] }], defaultAccountId: 'personal' });
  let calls = 0;
  const execute: ActionAdapter['execute'] = async (...args) => { calls++; return options.execute ? options.execute(...args) : { summary: 'Mock platform operation completed' }; };
  const adapters: ActionAdapter[] = [
    { provider: 'x', definition: { id: 'read', label: 'Read', description: 'Read fixture', group: 'analytics', kind: 'read', fields: [] }, execute },
    { provider: 'x', definition: { id: 'publish', label: 'Publish', description: 'Write fixture', group: 'publishing', kind: 'write', fields: [{ name: 'text', label: 'Text', type: 'textarea', required: true }] }, execute },
  ];
  const pipeline = new Pipeline(store, {}, {
    getAction(provider, action) { const adapter = adapters.find(item => item.provider === provider && item.definition.id === action); if (!adapter) throw new ProviderError('Unsupported test action.', 404); return adapter; },
    listActions: provider => adapters.filter(item => item.provider === provider).map(item => item.definition), validateValues,
  }, { refreshCredential: async (_provider, credential) => options.refreshCredential ? options.refreshCredential(credential) : credential });
  const app = createApp(config, store, undefined, {}, pipeline);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.origin = base;
  const localFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, base, 'integration tests must never call an AI or other external service');
    return fetch(input, { ...init, redirect: 'manual' });
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  });
  const request = (path: string, init: RequestInit = {}) => localFetch(`${base}${path}`, init);
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify({ password: config.password }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  };
  const owner = (cookie: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => request(path, { method,
    headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let rpcId = 0;
  const rpc = (key: string, method = 'tools/list', params: unknown = {}) => request('/mcp', { method: 'POST',
    headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { config, store, base, localFetch, request, login, owner, rpc, accounts, work, personal, calls: () => calls };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function pending(f: Fixture, provider: MemoryOAuthClient) {
  assert.ok(provider.authorizationUrl);
  const authorization = provider.authorizationUrl;
  assert.equal(authorization.origin, f.base);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('code_challenge'), createHash('sha256').update(provider.verifier).digest('base64url'));
  assert.equal(authorization.searchParams.get('resource'), `${f.base}/mcp`);
  const response = await f.localFetch(authorization);
  assert.equal(response.status, 302);
  const dashboard = new URL(response.headers.get('location')!, f.base);
  assert.equal(dashboard.origin, f.base);
  const id = dashboard.searchParams.get('authorize');
  assert.ok(id);
  return id;
}

async function approve(f: Fixture, provider: MemoryOAuthClient, selection: { platforms: boolean; workspaceProfileId?: string }) {
  const id = await pending(f, provider);
  assert.equal((await f.request(`/api/ai/authorize/${id}`)).status, 401, 'approval metadata requires owner login');
  const cookie = await f.login();
  const reviewResponse = await f.owner(cookie, `/api/ai/authorize/${id}`);
  assert.equal(reviewResponse.status, 200);
  const review = await reviewResponse.json() as { clientName: string; redirectUri: string; resource: string; workspaceProfiles: unknown[] };
  assert.equal(review.clientName, provider.clientMetadata.client_name);
  assert.equal(review.redirectUri, provider.redirectUrl);
  assert.equal(review.resource, `${f.base}/mcp`);
  const approval = await f.owner(cookie, `/api/ai/authorize/${id}`, { approve: true, ...selection });
  assert.equal(approval.status, 200);
  const callback = new URL((await approval.json() as { redirectUrl: string }).redirectUrl);
  assert.equal(callback.origin + callback.pathname, provider.redirectUrl);
  assert.equal(callback.searchParams.get('state'), provider.stateValue);
  const code = callback.searchParams.get('code');
  assert.ok(code);
  return { code, cookie, id };
}

async function connect(t: TestContext, f: Fixture, selection = { platforms: true } as { platforms: boolean; workspaceProfileId?: string }, method: ClientMethod = 'none') {
  const provider = new MemoryOAuthClient(method);
  const firstClient = new Client({ name: 'official-sdk-auth-test', version: '1.0.0' });
  const firstTransport = new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { authProvider: provider, fetch: f.localFetch });
  await assert.rejects(firstClient.connect(firstTransport), UnauthorizedError);
  await firstClient.close();
  assert.ok(provider.information?.client_id, 'SDK must perform dynamic client registration');
  const approval = await approve(f, provider, selection);
  const transport = new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { authProvider: provider, fetch: f.localFetch });
  await transport.finishAuth(approval.code);
  assert.ok(provider.savedTokens?.access_token);
  assert.ok(provider.savedTokens?.refresh_token);
  const client = new Client({ name: 'official-sdk-authenticated-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return { provider, client, ...approval };
}

test('public MCP SDK client discovers OAuth, registers, uses PKCE and owner consent, then calls tools without an AI API key', async t => {
  const f = await fixture(t);
  const unauthenticated = await f.request('/mcp');
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate') || '', /resource_metadata=/);
  const { client, provider, cookie } = await connect(t, f);
  const lastUsedAt = async () => {
    const response = await f.owner(cookie, '/api/ai/connectors');
    assert.equal(response.status, 200);
    const body = await response.json() as { grants: { lastUsedAt?: string }[] };
    assert.equal(body.grants.length, 1);
    return body.grants[0].lastUsedAt;
  };
  assert.equal(await lastUsedAt(), undefined, 'OAuth approval and MCP initialization do not prove a successful tool call');
  assert.equal(provider.information?.client_secret, undefined, 'public clients need no AI developer credential or client secret');
  const tools = await client.listTools();
  assert.equal(tools.tools.some(tool => tool.name === 'run_action'), true);
  assert.equal(tools.tools.some(tool => tool.name.includes('workspace')), false);
  assert.equal(await lastUsedAt(), undefined, 'listing tools does not mark the AI connection as successfully used');
  for (const arguments_ of [
    { provider: 'x', action: 'publish', values: { text: 'Unapproved fixture publication' }, requestId: 'oauth-initial-denied-write' },
    { provider: 'x', action: 'unsupported', values: {} },
  ]) assert.equal((await client.callTool({ name: 'run_action', arguments: arguments_ })).isError, true);
  assert.equal(f.calls(), 0);
  assert.equal(await lastUsedAt(), undefined, 'denied and failed tool calls must not display a successful connection check');
  const connected = await client.callTool({ name: 'list_connections', arguments: {} });
  const successAt = await lastUsedAt();
  assert.ok(successAt, 'the first successful tool call records an observable verification timestamp');
  assert.equal(new Date(successAt).toISOString(), successAt);
  assert.match(JSON.stringify(connected), /Social test account/);
  for (const secret of [platformKey, masterKey, 'private-google-', 'hidden@example.test']) assert.equal(JSON.stringify(connected).includes(secret), false);
  const connections = connected.structuredContent as { connections: { provider: string }[] };
  for (const id of ['anthropic', 'openai', 'xai']) assert.equal(connections.connections.some(connection => connection.provider === id), false, 'subscription connectors must not expose developer API cards as account requirements');
  const read = await client.callTool({ name: 'run_action', arguments: { provider: 'x', action: 'read', values: {} } });
  assert.notEqual(read.isError, true);
  const args = { provider: 'x', action: 'publish', values: { text: 'Approved fixture publication' }, requestId: 'oauth-sdk-write-123' };
  assert.equal((await client.callTool({ name: 'run_action', arguments: args })).isError, true);
  assert.equal(f.calls(), 1, 'unapproved writes do not reach the platform');
  for (let index = 0; index < 2; index++) assert.notEqual((await client.callTool({ name: 'run_action', arguments: { ...args, confirmed: true } })).isError, true);
  assert.equal(f.calls(), 2, 'retrying the approved write uses its existing receipt');
  for (const path of ['/api/v1/connections', '/api/v1/workspace/accounts', '/api/settings', '/api/ai/connectors']) {
    const response = await f.request(path, { headers: { authorization: `Bearer ${provider.savedTokens!.access_token}` } });
    assert.notEqual(response.status, 200, `OAuth token must not authorize ${path}`);
  }
  const bot = await f.request('/api/v1/bot/turn', { method: 'POST', headers: { authorization: `Bearer ${provider.savedTokens!.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'This must not call an AI API.' }] }) });
  assert.equal(bot.status, 403, 'OAuth subscription connections cannot invoke the separately billed API bot');
});

for (const method of ['client_secret_basic', 'client_secret_post'] as const) {
  test(`confidential MCP SDK client supports ${method} registration, exchange, and refresh`, async t => {
    const f = await fixture(t);
    const { provider, client } = await connect(t, f, { platforms: true }, method);
    assert.ok(provider.information?.client_secret);
    assert.equal((provider.information as OAuthClientInformationMixed & OAuthClientMetadata).token_endpoint_auth_method, method);
    const previous = { ...provider.savedTokens! };
    assert.equal(await auth(provider, { serverUrl: `${f.base}/mcp`, fetchFn: f.localFetch }), 'AUTHORIZED');
    assert.notEqual(provider.savedTokens!.access_token, previous.access_token);
    assert.notEqual(provider.savedTokens!.refresh_token, previous.refresh_token);
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'list_connections'), true);
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: provider.information!.client_id,
      refresh_token: provider.savedTokens!.refresh_token!, resource: `${f.base}/mcp` });
    const rejected = await f.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    assert.ok([400, 401].includes(rejected.status), 'confidential clients cannot omit their client secret');
  });
}

test('OAuth consent independently restricts standard platforms and the selected Google Workspace profile', async t => {
  const f = await fixture(t);
  const standard = await connect(t, f, { platforms: true });
  const workspace = await connect(t, f, { platforms: false, workspaceProfileId: f.work.profile.id });
  const combined = await connect(t, f, { platforms: true, workspaceProfileId: f.personal.profile.id });
  const names = async (client: Client) => (await client.listTools()).tools.map(tool => tool.name);
  assert.equal((await names(standard.client)).includes('list_workspace_accounts'), false);
  assert.deepEqual((await names(workspace.client)).sort(), ['list_workspace_accounts', 'list_workspace_actions', 'run_workspace_action']);
  for (const name of ['list_connections', 'list_workspace_accounts']) assert.ok((await names(combined.client)).includes(name));
  for (const [connection, expected, disallowed] of [[workspace, 'work@example.test', 'personal@example.test'], [combined, 'personal@example.test', 'work@example.test']] as const) {
    const result = await connection.client.callTool({ name: 'list_workspace_accounts', arguments: {} });
    const text = JSON.stringify(result);
    assert.match(text, new RegExp(expected.replace('.', '\\.')));
    for (const secret of [disallowed, 'hidden@example.test', 'private-google-', f.work.apiKey, f.personal.apiKey]) assert.equal(text.includes(secret), false);
    const denied = await connection.client.callTool({ name: 'list_workspace_actions', arguments: { app: 'sheets', accountId: 'hidden' } });
    assert.equal(denied.isError, true);
  }
  f.accounts.updateProfile(f.work.profile.id, { name: 'Work assistant', bindings: [] });
  assert.equal((await workspace.client.callTool({ name: 'list_workspace_actions', arguments: { app: 'sheets', accountId: 'work' } })).isError, true, 'permission changes take effect without reconnecting other accounts');
  f.accounts.deleteProfile(f.personal.profile.id);
  const revokedProfile = await f.rpc(combined.provider.savedTokens!.access_token, 'tools/call', { name: 'list_workspace_accounts', arguments: {} });
  assert.ok(revokedProfile.status === 401 || (await revokedProfile.text()).includes('isError'), 'a deleted profile cannot expose its accounts');
});

test('SDK refreshed tokens can be revoked; legacy platform and Workspace keys remain independent', async t => {
  const f = await fixture(t);
  const { provider } = await connect(t, f, { platforms: true, workspaceProfileId: f.work.profile.id });
  assert.equal(await auth(provider, { serverUrl: `${f.base}/mcp`, fetchFn: f.localFetch }), 'AUTHORIZED');
  const tokens = { ...provider.savedTokens! };
  const revoked = await f.request('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tokens.refresh_token!, token_type_hint: 'refresh_token', client_id: provider.information!.client_id }) });
  assert.equal(revoked.status, 200);
  assert.equal((await f.rpc(tokens.access_token)).status, 401);
  const refresh = await f.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: provider.information!.client_id, resource: `${f.base}/mcp` }) });
  assert.equal(refresh.status, 400);
  assert.equal((await refresh.json() as { error: string }).error, 'invalid_grant');
  assert.equal((await f.rpc(masterKey)).status, 200);
  assert.equal((await f.rpc(f.work.apiKey)).status, 200);
});

test('owner rejection preserves OAuth state and approval requires the owner session and CSRF header', async t => {
  const f = await fixture(t);
  const provider = new MemoryOAuthClient();
  assert.equal(await auth(provider, { serverUrl: `${f.base}/mcp`, fetchFn: f.localFetch }), 'REDIRECT');
  const id = await pending(f, provider);
  const approval = { approve: true, platforms: true };
  assert.equal((await f.owner('', `/api/ai/authorize/${id}`, approval)).status, 401);
  const cookie = await f.login();
  assert.equal((await f.owner(cookie, `/api/ai/authorize/${id}`)).status, 200);
  const noCsrf = await f.request(`/api/ai/authorize/${id}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(approval) });
  assert.equal(noCsrf.status, 403);
  const foreignOrigin = await f.request(`/api/ai/authorize/${id}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1', origin: 'https://foreign.example.test' }, body: JSON.stringify(approval) });
  assert.equal(foreignOrigin.status, 403, 'a valid owner cookie cannot approve consent from a foreign origin');
  const denial = await f.owner(cookie, `/api/ai/authorize/${id}`, { approve: false });
  assert.equal(denial.status, 200);
  const callback = new URL((await denial.json() as { redirectUrl: string }).redirectUrl);
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.get('state'), provider.stateValue);
  assert.equal(callback.searchParams.has('code'), false);
  assert.notEqual((await f.owner(cookie, `/api/ai/authorize/${id}`, approval)).status, 200, 'denied consent cannot be approved again');
});

test('origin changes invalidate existing OAuth tokens and advertise the current public MCP resource', async t => {
  const f = await fixture(t);
  const { provider } = await connect(t, f);
  const before = provider.savedTokens!.access_token;
  f.config.origin = 'https://updated-public-tunnel.example.test';
  assert.equal((await f.rpc(before)).status, 401);
  const metadata = await (await f.request('/.well-known/oauth-protected-resource/mcp')).json() as { resource: string; authorization_servers: string[] };
  assert.equal(metadata.resource, `${f.config.origin}/mcp`);
  assert.deepEqual(metadata.authorization_servers, [f.config.origin]);
  const authorization = await (await f.request('/.well-known/oauth-authorization-server')).json() as { issuer: string; authorization_endpoint: string; token_endpoint: string };
  assert.equal(authorization.issuer, f.config.origin);
  assert.equal(authorization.authorization_endpoint, `${f.config.origin}/oauth/authorize`);
  assert.equal(authorization.token_endpoint, `${f.config.origin}/oauth/token`);
  assert.equal((await f.rpc(masterKey)).status, 200, 'a tunnel change does not erase saved platform credentials');
});

async function disconnect(f: Fixture, cookie: string) {
  const response = await f.owner(cookie, '/api/ai/connectors');
  assert.equal(response.status, 200);
  const body = await response.json() as { grants: { id: string }[] };
  assert.equal(body.grants.length, 1);
  assert.equal((await f.owner(cookie, `/api/ai/connectors/${body.grants[0].id}`, undefined, 'DELETE')).status, 200);
}

test('disconnecting an AI during a platform read suppresses its pending private result and challenges the next MCP request', async t => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  t.after(() => release());
  const f = await fixture(t, { execute: async () => {
    started();
    await gate;
    return { summary: 'private-platform-content-returned-after-revocation' };
  } });
  const { client, provider, cookie } = await connect(t, f);
  const request = client.callTool({ name: 'run_action', arguments: { provider: 'x', action: 'read', values: {} } });
  await dispatched;
  await disconnect(f, cookie);
  release();
  const result = await request;
  assert.equal(result.isError, true);
  assert.equal(JSON.stringify(result).includes('private-platform-content-returned-after-revocation'), false);
  const rejected = await f.rpc(provider.savedTokens!.access_token);
  assert.equal(rejected.status, 401);
  assert.match(rejected.headers.get('www-authenticate') || '', /resource_metadata=/);
  assert.equal(f.calls(), 1);
});

test('disconnecting an AI during credential refresh prevents the pending platform write from dispatching', async t => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const refreshing = new Promise<void>(resolve => { started = resolve; });
  t.after(() => release());
  const f = await fixture(t, { refreshCredential: async credential => {
    started();
    await gate;
    return { ...credential, expiresAt: Date.now() + 3_600_000 };
  } });
  const { client, cookie } = await connect(t, f);
  const requestId = 'oauth-revoked-during-refresh';
  const request = client.callTool({ name: 'run_action', arguments: { provider: 'x', action: 'publish', values: { text: 'Must not publish' }, confirmed: true, requestId } });
  await refreshing;
  await disconnect(f, cookie);
  release();
  assert.equal((await request).isError, true);
  assert.equal(f.calls(), 0, 'revoked consent cannot dispatch a write after refresh completes');
  assert.equal(f.store.job(requestId)?.status, 'failed');
  assert.ok(f.store.credential('x'), 'disconnecting an AI preserves the owner’s platform connection');
});
