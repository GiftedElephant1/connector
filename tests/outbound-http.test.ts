import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app';
import type { AppConfig } from '../server/config';
import { McpOAuth } from '../server/mcp-oauth';
import { OutboundAI } from '../server/outbound-ai';
import { Store } from '../server/store';
import { WorkspaceAccounts } from '../server/workspace-accounts';

const masterKey = 'test-outbound-master-key-12345678901234567890';
const aiTools = ['cancel_ai_task', 'check_ai_agent', 'get_ai_task', 'list_ai_agents', 'list_ai_tasks', 'start_ai_task'];

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'connector-outbound-http-'));
  const config: AppConfig = { origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000,
    password: 'test-owner-workspace-password', encryptionKey: Buffer.alloc(32, 94),
    databasePath: join(directory, 'test.sqlite'), secureCookies: false, pipelineKey: masterKey };
  const store = new Store(config.databasePath, config.encryptionKey);
  let calls = 0;
  let checks = 0;
  const outbound = new OutboundAI(store, config.databasePath, {
    localRun: async () => { calls++; return { result: 'Fixture answer without external calls' }; },
    localCheck: async () => { checks++; return { available: true, authenticated: true, status: 'ready', message: 'Fixture saved subscription sign-in; no task sent.' }; },
  });
  outbound.configure('claude', { enabled: true });
  outbound.configure('cursor', { enabled: false, apiKey: 'private-cursor-api-key', model: 'fixture-model' });
  const accounts = new WorkspaceAccounts(config, store, {});
  const workspaceKey = accounts.createProfile({ name: 'Google-only assistant', bindings: [] }).apiKey;
  const oauth = new McpOAuth(config, store, accounts);
  const app = createApp(config, store, undefined, {}, undefined, { outbound });
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  config.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${config.origin}${path}`, { ...init, redirect: 'manual' });
  const signedIn = await request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify({ password: config.password }) });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get('set-cookie')!.split(';')[0];
  const owner = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => request(path, { method,
    headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let rpcId = 0;
  const rpc = (key: string, method = 'tools/list', params: unknown = {}) => request('/mcp', { method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const tool = (key: string, name: string, args: unknown = {}) => rpc(key, 'tools/call', { name, arguments: args });
  const restTool = (key: string, name: string, args: unknown = {}) => request(`/api/v1/tools/${name}`, { method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const restAction = (key: string, provider: string, action: string, body: unknown = { values: {} }) => request(`/api/v1/actions/${provider}/${action}`, { method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const completed = async (id: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const task = await outbound.get(id, 'owner');
      if (task.status !== 'running') { assert.equal(task.status, 'succeeded'); return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('The injected local runner did not finish its fixture task.');
  };
  const grant = (permissions: { platforms?: boolean; outbound?: boolean }) => {
    const client = oauth.register({ client_name: 'Fixture AI', redirect_uris: ['https://fixture-ai.example/callback'] });
    const verifier = 'v'.repeat(64);
    const pending = new URL(oauth.start({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: oauth.resource() })).searchParams.get('authorize')!;
    const session = store.createSession();
    oauth.consent(pending, session);
    const code = new URL(oauth.approve(pending, session, { approve: true, ...permissions }).redirectUrl).searchParams.get('code')!;
    return oauth.token({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code, code_verifier: verifier }).access_token;
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await outbound.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { config, store, outbound, oauth, request, owner, cookie, rpc, tool, restTool, restAction, grant, workspaceKey, completed, calls: () => calls, checks: () => checks };
}

const taskInput = (requestId: string) => ({ provider: 'claude', prompt: 'Explain the supplied phrase in plain language.', confirmed: true, requestId });

interface ToolCatalog { tools: { name: string; description: string; inputSchema: { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } }[] }
interface ConnectionDiscovery {
  connectorVersion: string;
  authentication?: 'api_key' | 'oauth';
  connections: { provider: string; status: string; connectionType?: string; enabled?: boolean; configured?: boolean; delegationAllowed?: boolean;
    check?: unknown; actions: { id: string; kind: string }[] }[];
  aiDelegation?: {
    delegationAllowed: boolean;
    agents: { provider: string; enabled: boolean; configured: boolean; returnsResult: boolean }[];
    toolsEndpoint: string;
    workflow: string[];
  };
}
interface ClassicActions { actions: { id: string; kind: string; fields: { name: string; required?: boolean }[]; schedulable?: boolean }[] }
interface ClassicTaskReceipt {
  task: { id: string; provider: string; status: string; result?: string };
  result: { summary: string; items: { id: string; provider: string; status: string; result?: string }[] };
}

test('classic REST connection and action discovery lets a source agent delegate to Claude and retrieve its answer', async t => {
  const f = await fixture(t);
  await f.owner('/api/outbound-ai/access', { allowSharedKey: true });
  const headers = { authorization: `Bearer ${masterKey}` };
  const connections = await (await f.request('/api/v1/connections', { headers })).json() as ConnectionDiscovery;
  assert.match(connections.connectorVersion, /^\d+\.\d+\.\d+/);
  assert.equal(connections.authentication, 'api_key');
  const claude = connections.connections.find(connection => connection.provider === 'claude');
  assert.ok(claude, 'Claude is a discoverable connection through the original platform workflow');
  assert.equal(claude.connectionType, 'outbound_ai');
  assert.equal(claude.status, 'enabled');
  assert.equal(claude.enabled, true);
  assert.equal(claude.delegationAllowed, true);
  assert.ok(claude.actions.some(action => action.id === 'start-task' && action.kind === 'write'));
  assert.ok(connections.connections.some(connection => connection.provider === 'anthropic' && connection.connectionType !== 'outbound_ai'), 'developer API accounts retain their separate provider IDs');
  assert.equal(connections.connections.filter(connection => connection.connectionType === 'outbound_ai').length, 5);
  assert.equal(connections.connections.find(connection => connection.provider === 'cursor')?.status, 'disabled');

  const actions = await (await f.request('/api/v1/actions/claude', { headers })).json() as ClassicActions;
  assert.deepEqual(actions.actions.map(action => action.id).sort(), ['cancel-task', 'check-connection', 'get-task', 'list-tasks', 'start-task']);
  assert.deepEqual(actions.actions.find(action => action.id === 'start-task')?.fields.map(field => ({ name: field.name, required: field.required })), [{ name: 'prompt', required: true }]);
  assert.ok(actions.actions.every(action => !action.schedulable));
  assert.deepEqual(await (await f.request('/api/v1/actions/unknown-agent', { headers })).json(), { actions: [] });
  for (const id of ['anthropic', 'openai', 'xai']) {
    const original = await (await f.request(`/api/v1/actions/${id}`, { headers })).json() as ClassicActions;
    assert.equal(original.actions.some(action => action.id === 'start-task'), false, `${id} must not become an alias for subscription delegation`);
  }
  const check = await f.restAction(masterKey, 'claude', 'check-connection');
  assert.equal(check.status, 200);
  assert.equal(f.checks(), 1);
  assert.equal(f.calls(), 0);
  const input = { values: { prompt: 'Explain this supplied phrase in plain language.' }, confirmed: true, requestId: 'classic-rest-source-task' };
  const started = await f.restAction(masterKey, 'claude', 'start-task', input);
  assert.equal(started.status, 200);
  const receipt = await started.json() as ClassicTaskReceipt;
  assert.equal(receipt.task.provider, 'claude');
  assert.equal(receipt.result.items[0].id, receipt.task.id);
  const repeated = await f.restAction(masterKey, 'claude', 'start-task', input);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json() as ClassicTaskReceipt).task.id, receipt.task.id);
  await f.completed(receipt.task.id);
  const read = await f.restAction(masterKey, 'claude', 'get-task', { values: { id: receipt.task.id } });
  assert.equal(read.status, 200);
  const completed = await read.json() as ClassicTaskReceipt;
  assert.equal(completed.task.status, 'succeeded');
  assert.equal(completed.result.items[0].result, 'Fixture answer without external calls');
  assert.equal(completed.task.result, completed.result.items[0].result);
  assert.equal((await f.restAction(masterKey, 'gemini', 'get-task', { values: { id: receipt.task.id } })).status, 404, 'provider IDs cannot be changed when reading a receipt');
  assert.equal(f.calls(), 1, 'classic retries reuse the original receipt instead of running another task');
});

test('classic AI actions enforce shared-key opt-in, confirmation, strict fields and provider state', async t => {
  const f = await fixture(t);
  const headers = { authorization: `Bearer ${masterKey}` };
  const connections = await (await f.request('/api/v1/connections', { headers })).json() as ConnectionDiscovery;
  const destinations = connections.connections.filter(connection => connection.connectionType === 'outbound_ai');
  assert.equal(destinations.length, 5);
  assert.ok(destinations.every(connection => connection.status === 'authorization_required' && connection.enabled === false && connection.delegationAllowed === false));
  const input = { values: { prompt: 'A task that must require the owner’s explicit authorization.' }, confirmed: true, requestId: 'classic-permission-boundary' };
  assert.equal((await f.restAction(masterKey, 'claude', 'start-task', input)).status, 403);
  assert.equal((await f.restAction(masterKey, 'claude', 'check-connection')).status, 403);
  await f.owner('/api/outbound-ai/access', { allowSharedKey: true });
  const unapproved = await f.restAction(masterKey, 'claude', 'start-task', { ...input, confirmed: false });
  assert.ok([400, 409].includes(unapproved.status));
  assert.equal((await f.restAction(masterKey, 'claude', 'start-task', { ...input, values: { ...input.values, executable: '/untrusted/program' } })).status, 400);
  assert.equal((await f.restAction(masterKey, 'cursor', 'start-task', input)).status, 409);
  assert.equal((await f.restAction(f.workspaceKey, 'claude', 'start-task', input)).status, 403);
  assert.equal(f.calls(), 0);
  assert.equal(f.checks(), 0);
});

test('classic MCP AI actions remain scoped to explicit outbound OAuth grants and isolate receipts', async t => {
  const f = await fixture(t);
  const platformsOnly = f.grant({ platforms: true });
  const permitted = f.grant({ platforms: true, outbound: true });
  const outboundOnly = f.grant({ outbound: true });
  const connectionsFor = async (key: string) => (await (await f.tool(key, 'list_connections')).json() as { result: { structuredContent: ConnectionDiscovery } }).result.structuredContent;
  const locked = await connectionsFor(platformsOnly);
  assert.match(locked.connectorVersion, /^\d+\.\d+\.\d+/);
  assert.equal(locked.authentication, 'oauth');
  const lockedClaude = locked.connections.find(connection => connection.provider === 'claude');
  assert.equal(lockedClaude?.status, 'authorization_required');
  assert.equal(lockedClaude?.enabled, false);
  assert.equal(lockedClaude?.configured, undefined, 'unapproved OAuth clients cannot inspect outbound setup');
  assert.equal(lockedClaude?.check, undefined);
  const permittedConnections = await connectionsFor(permitted);
  assert.equal(permittedConnections.connections.find(connection => connection.provider === 'claude')?.status, 'enabled');
  const limited = await connectionsFor(outboundOnly);
  assert.deepEqual(limited.connections.map(connection => connection.provider).sort(), ['chatgpt', 'claude', 'cursor', 'gemini', 'grok']);
  const restrictedActions = await (await f.tool(outboundOnly, 'list_actions', { provider: 'x' })).json() as { result: { structuredContent?: ClassicActions; isError?: boolean } };
  assert.ok(restrictedActions.result.isError || restrictedActions.result.structuredContent?.actions.length === 0, 'an outbound-only approval must not disclose platform action schemas');
  const defs = await (await f.tool(permitted, 'list_actions', { provider: 'claude' })).json() as { result: { structuredContent: ClassicActions } };
  assert.ok(defs.result.structuredContent.actions.some(action => action.id === 'start-task'));
  const input = { provider: 'claude', action: 'start-task', values: { prompt: 'Return a concise explanation.' }, confirmed: true, requestId: 'classic-oauth-task' };
  const denied = await (await f.tool(platformsOnly, 'run_action', input)).json() as { result: { isError: boolean } };
  assert.equal(denied.result.isError, true);
  const platformWrite = await (await f.tool(outboundOnly, 'run_action', { ...input, provider: 'x', action: 'publish', values: { text: 'Must not be posted' } })).json() as { result: { isError: boolean } };
  assert.equal(platformWrite.result.isError, true);
  const started = await (await f.tool(permitted, 'run_action', input)).json() as { result: { isError?: boolean; structuredContent: ClassicTaskReceipt } };
  assert.notEqual(started.result.isError, true);
  const id = started.result.structuredContent.task.id;
  await f.completed(id);
  const readArgs = { provider: 'claude', action: 'get-task', values: { id } };
  const own = await (await f.tool(permitted, 'run_action', readArgs)).json() as { result: { structuredContent: ClassicTaskReceipt } };
  assert.equal(own.result.structuredContent.task.result, 'Fixture answer without external calls');
  const foreign = await (await f.tool(outboundOnly, 'run_action', readArgs)).json() as { result: { isError: boolean } };
  assert.equal(foreign.result.isError, true);
  const unapproved = await (await f.tool(platformsOnly, 'run_action', readArgs)).json() as { result: { isError: boolean } };
  assert.equal(unapproved.result.isError, true);
  f.oauth.disconnect(f.oauth.assertCurrent(permitted).grantId);
  assert.equal((await f.tool(permitted, 'run_action', readArgs)).status, 401);
  assert.equal(f.calls(), 1);
});

test('only the signed-in owner can enable or remove delegation for an existing OAuth connection without replacing its token', async t => {
  const f = await fixture(t);
  const token = f.grant({ platforms: true });
  const id = f.oauth.assertCurrent(token).grantId;
  const path = `/api/ai/connectors/${id}/outbound`;
  const approval = { enabled: true, confirmed: true };
  for (const key of [masterKey, token, f.workspaceKey]) {
    const response = await f.request(path, { method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify(approval) });
    assert.equal(response.status, 401);
  }
  const missingCsrf = await f.request(path, { method: 'PUT', headers: { cookie: f.cookie, 'content-type': 'application/json' }, body: JSON.stringify(approval) });
  assert.equal(missingCsrf.status, 403);
  for (const invalid of [{ enabled: true, confirmed: false }, { enabled: 'true', confirmed: true }, { enabled: true }, { ...approval, platforms: true }]) {
    assert.equal((await f.owner(path, invalid, 'PUT')).status, 400);
  }
  assert.equal(f.oauth.assertCurrent(token).outbound, false);
  const before = await (await f.tool(token, 'run_action', { provider: 'claude', action: 'check-connection', values: {} })).json() as { result: { isError: boolean } };
  assert.equal(before.result.isError, true);
  assert.equal(f.checks(), 0);

  assert.equal((await f.owner(path, approval, 'PUT')).status, 200);
  assert.equal(f.oauth.assertCurrent(token).outbound, true, 'the original token uses the owner’s current permission decision');
  const started = await (await f.tool(token, 'run_action', { provider: 'claude', action: 'start-task', values: { prompt: 'Explain this supplied text.' }, confirmed: true, requestId: 'owner-enabled-existing-oauth' })).json() as { result: { structuredContent: ClassicTaskReceipt } };
  const taskId = started.result.structuredContent.task.id;
  await f.completed(taskId);
  assert.equal((await f.owner(path, { enabled: false, confirmed: true }, 'PUT')).status, 200);
  const current = f.oauth.assertCurrent(token);
  assert.equal(current.outbound, false);
  assert.equal(current.platforms, true, 'changing delegation leaves the connection’s existing platform approval intact');
  const denied = await (await f.tool(token, 'run_action', { provider: 'claude', action: 'get-task', values: { id: taskId } })).json() as { result: { isError: boolean } };
  assert.equal(denied.result.isError, true);
  assert.equal((await f.owner(`/api/outbound-ai/tasks/${taskId}`)).status, 200);
  assert.equal(f.calls(), 1);
});

test('REST connections expose authorized AI discovery and a source agent can dispatch and read a result using the discovered tools', async t => {
  const f = await fixture(t);
  const headers = { authorization: `Bearer ${masterKey}` };
  assert.equal((await f.request('/api/v1/tools')).status, 401);
  const before = await f.request('/api/v1/connections', { headers });
  assert.equal(before.status, 200);
  const locked = await before.json() as ConnectionDiscovery;
  assert.ok(locked.connections.length > 0, 'existing platform discovery stays available');
  assert.equal(locked.aiDelegation?.delegationAllowed, false);
  assert.ok(locked.aiDelegation?.agents.every(agent => !agent.enabled));
  assert.equal((await f.restTool(masterKey, 'check_ai_agent', { provider: 'claude' })).status, 403);
  assert.equal((await f.restTool(masterKey, 'start_ai_task', taskInput('discovered-but-not-authorized'))).status, 403);
  assert.equal(f.calls(), 0);
  assert.equal(f.checks(), 0);

  await f.owner('/api/outbound-ai/access', { allowSharedKey: true });
  const discovered = await (await f.request('/api/v1/connections', { headers })).json() as ConnectionDiscovery;
  assert.equal(discovered.aiDelegation?.delegationAllowed, true);
  assert.equal(discovered.aiDelegation.toolsEndpoint, '/api/v1/tools');
  for (const required of ['list_ai_agents', 'check_ai_agent', 'start_ai_task', 'get_ai_task']) assert.ok(discovered.aiDelegation.workflow.includes(required));
  const destination = discovered.aiDelegation.agents.find(agent => agent.provider === 'claude');
  assert.ok(destination?.enabled && destination.configured && destination.returnsResult);
  const catalogResponse = await f.request(discovered.aiDelegation.toolsEndpoint, { headers });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json() as ToolCatalog;
  assert.ok(catalog.tools.some(tool => tool.name === 'list_connections'));
  for (const name of discovered.aiDelegation.workflow) assert.ok(catalog.tools.some(tool => tool.name === name), `${name} is invocable through the advertised endpoint`);
  const start = catalog.tools.find(tool => tool.name === 'start_ai_task')!;
  assert.ok(start.description.length > 0);
  assert.equal(start.inputSchema.type, 'object');
  assert.equal(start.inputSchema.additionalProperties, false);
  assert.deepEqual(new Set(start.inputSchema.required), new Set(['provider', 'prompt', 'confirmed', 'requestId']));
  assert.ok(start.inputSchema.properties?.provider);
  assert.equal(JSON.stringify({ discovered, catalog }).includes('private-cursor-api-key'), false);
  const post = async (name: string, args: unknown) => f.request(`${discovered.aiDelegation!.toolsEndpoint}/${name}`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  assert.equal((await post('check_ai_agent', { provider: destination.provider, executable: '/untrusted/program' })).status, 400);
  assert.equal((await post('check_ai_agent', { provider: 'cursor' })).status, 409, 'a machine cannot check an agent the owner disabled');
  const checked = await post('check_ai_agent', { provider: destination.provider });
  assert.equal(checked.status, 200);
  const readiness = await checked.json() as { provider: string; enabled: boolean; check: { status: string; message: string } };
  assert.equal(readiness.provider, destination.provider);
  assert.equal(readiness.enabled, true);
  assert.equal(readiness.check.status, 'ready');
  assert.equal(JSON.stringify(readiness).includes('private-cursor-api-key'), false);
  assert.equal(f.checks(), 1);
  assert.equal(f.calls(), 0, 'checking readiness must not send a model task');
  const started = await post(start.name, { ...taskInput('rest-discovery-flow'), provider: destination.provider });
  assert.equal(started.status, 200);
  const { task } = await started.json() as { task: { id: string } };
  let result: { id: string; status: string; result?: string } | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await post('get_ai_task', { id: task.id });
    assert.equal(response.status, 200);
    result = (await response.json() as { task: typeof result }).task;
    if (result?.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(result?.id, task.id);
  assert.equal(result?.status, 'succeeded');
  assert.equal(result?.result, 'Fixture answer without external calls');
  assert.equal(f.calls(), 1, 'the source agent uses the machine API without an owner task submission');
});

test('REST discovery respects Workspace key scope and OAuth platform discovery requires explicit outbound approval', async t => {
  const f = await fixture(t);
  await f.owner('/api/outbound-ai/access', { allowSharedKey: true });
  const workspaceHeaders = { authorization: `Bearer ${f.workspaceKey}` };
  const catalog = await f.request('/api/v1/tools', { headers: workspaceHeaders });
  assert.equal(catalog.status, 200);
  const body = await catalog.json() as ToolCatalog;
  assert.deepEqual(body.tools.map(tool => tool.name).sort(), ['list_workspace_accounts', 'list_workspace_actions', 'run_workspace_action']);
  assert.equal((await f.request('/api/v1/connections', { headers: workspaceHeaders })).status, 403);
  assert.equal((await f.restTool(f.workspaceKey, 'list_connections')).status, 404);
  assert.equal((await f.restTool(f.workspaceKey, 'list_ai_agents')).status, 404);
  assert.equal((await f.restTool(f.workspaceKey, 'check_ai_agent', { provider: 'claude' })).status, 404);
  assert.equal((await f.restTool(f.workspaceKey, 'start_ai_task', taskInput('discovery-workspace-denied'))).status, 404);
  const platforms = f.grant({ platforms: true });
  const withOutbound = f.grant({ platforms: true, outbound: true });
  for (const [token, expected] of [[platforms, false], [withOutbound, true]] as const) {
    assert.equal((await f.request('/api/v1/tools', { headers: { authorization: `Bearer ${token}` } })).status, 403, 'OAuth remains MCP-only');
    const response = await f.tool(token, 'list_connections');
    assert.equal(response.status, 200);
    const connections = await response.json() as { result: { structuredContent: ConnectionDiscovery } };
    assert.equal(connections.result.structuredContent.aiDelegation?.delegationAllowed, expected);
  }
  assert.equal(f.calls(), 0, 'reading discovery cannot dispatch an AI task');
  assert.equal(f.checks(), 0, 'reading discovery cannot run an account check');
});

test('outbound setup and credentials require an owner session and CSRF protection', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/outbound-ai')).status, 401);
  assert.equal((await f.owner('/api/outbound-ai/tasks', taskInput('removed-owner-form'))).status, 404, 'task creation is available through authorized AI tools, not the owner dashboard');
  for (const key of [masterKey, f.workspaceKey, f.grant({ outbound: true })]) {
    assert.equal((await f.request('/api/outbound-ai', { headers: { authorization: `Bearer ${key}` } })).status, 401);
    assert.equal((await f.request('/api/outbound-ai/providers/cursor', { method: 'PUT', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-connector-request': '1',
    }, body: JSON.stringify({ enabled: false, apiKey: 'replacement-secret', model: 'other-model' }) })).status, 401);
  }
  assert.equal((await f.request('/api/outbound-ai/access', { method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ allowSharedKey: true }) })).status, 403);
  assert.equal((await f.request('/api/outbound-ai/access', { method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json', 'x-connector-request': '1', origin: 'https://foreign.example' }, body: JSON.stringify({ allowSharedKey: true }) })).status, 403);
  const snapshot = await f.owner('/api/outbound-ai');
  assert.equal(snapshot.status, 200);
  const body = await snapshot.json() as { allowSharedKey: boolean; providers: { id: string; hasApiKey?: boolean }[] };
  assert.equal(body.allowSharedKey, false);
  assert.equal(body.providers.find(provider => provider.id === 'cursor')?.hasApiKey, true);
  assert.equal(JSON.stringify(body).includes('private-cursor-api-key'), false);
  assert.equal(f.calls(), 0);
});

test('shared Connector key requires owner opt-in and loses task access when disabled', async t => {
  const f = await fixture(t);
  const discovery = await f.restTool(masterKey, 'list_ai_agents');
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json() as { delegationAllowed: boolean }).delegationAllowed, false);
  assert.equal((await f.restTool(masterKey, 'start_ai_task', taskInput('shared-task-before'))).status, 403);
  assert.equal(f.calls(), 0);
  assert.equal((await f.owner('/api/outbound-ai/access', { allowSharedKey: true })).status, 200);
  assert.equal((await f.restTool(masterKey, 'start_ai_task', { ...taskInput('missing-approval'), confirmed: false })).status, 400);
  assert.equal((await f.restTool(masterKey, 'start_ai_task', { ...taskInput('injected-path'), executable: '/untrusted/program' })).status, 400);
  assert.equal((await f.restTool(masterKey, 'start_ai_task', { ...taskInput('injected-owner'), principal: 'owner' })).status, 400);
  assert.equal(f.calls(), 0);
  const started = await f.restTool(masterKey, 'start_ai_task', taskInput('shared-task-after'));
  assert.equal(started.status, 200);
  const receipt = await started.json() as { task: { id: string } };
  const retry = await f.restTool(masterKey, 'start_ai_task', taskInput('shared-task-after'));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as { task: { id: string } }).task.id, receipt.task.id);
  assert.equal((await f.restTool(masterKey, 'get_ai_task', { id: receipt.task.id })).status, 200);
  await f.completed(receipt.task.id);
  assert.equal(f.calls(), 1, 'repeated receipt requests must not dispatch a second local process');
  assert.equal((await f.owner('/api/outbound-ai/access', { allowSharedKey: false })).status, 200);
  assert.equal((await f.restTool(masterKey, 'get_ai_task', { id: receipt.task.id })).status, 403);
  assert.equal((await f.restTool(masterKey, 'list_ai_tasks')).status, 403);
  assert.equal((await f.owner(`/api/outbound-ai/tasks/${receipt.task.id}`)).status, 200, 'the owner retains their task history');
});

test('Google Workspace keys and old platform OAuth approvals cannot gain outbound delegation', async t => {
  const f = await fixture(t);
  await f.owner('/api/outbound-ai/access', { allowSharedKey: true });
  const existing = f.grant({ platforms: true });
  const saved = f.store.readSetting<{ grants: { outbound?: boolean }[] }>('mcp.oauth.v1')!;
  for (const grant of saved.grants) delete grant.outbound;
  f.store.writeSetting('mcp.oauth.v1', saved);
  for (const key of [f.workspaceKey, existing]) {
    const response = await f.rpc(key);
    assert.equal(response.status, 200);
    const body = await response.json() as { result: { tools: { name: string }[] } };
    assert.equal(body.result.tools.some(tool => aiTools.includes(tool.name)), false);
    const forbidden = await f.tool(key, 'start_ai_task', taskInput('must-not-dispatch'));
    const rejected = await forbidden.json() as { error?: unknown; result?: { isError?: boolean } };
    assert.ok(rejected.error || rejected.result?.isError);
    const forbiddenCheck = await f.tool(key, 'check_ai_agent', { provider: 'claude' });
    const rejectedCheck = await forbiddenCheck.json() as { error?: unknown; result?: { isError?: boolean } };
    assert.ok(rejectedCheck.error || rejectedCheck.result?.isError);
  }
  assert.equal((await f.restTool(f.workspaceKey, 'start_ai_task', taskInput('workspace-denied'))).status, 404);
  assert.equal((await f.restTool(existing, 'start_ai_task', taskInput('oauth-rest-denied'))).status, 403);
  assert.equal(f.calls(), 0);
  assert.equal(f.checks(), 0);
});

test('outbound-only OAuth grants expose delegation tools with restricted classic discovery, isolate receipts, and stop access after revocation', async t => {
  const f = await fixture(t);
  const first = f.grant({ outbound: true });
  const second = f.grant({ outbound: true });
  const listing = await f.rpc(first);
  assert.equal(listing.status, 200);
  const tools = await listing.json() as { result: { tools: { name: string }[] } };
  assert.deepEqual(tools.result.tools.map(tool => tool.name).sort(), [...aiTools, 'list_actions', 'list_connections', 'run_action'].sort());
  const check = await (await f.tool(first, 'check_ai_agent', { provider: 'claude' })).json() as { result: { structuredContent: { check: { status: string } } } };
  assert.equal(check.result.structuredContent.check.status, 'ready');
  assert.equal(f.checks(), 1);
  assert.equal(f.calls(), 0);
  const started = await f.tool(first, 'start_ai_task', taskInput('oauth-private-task'));
  const response = await started.json() as { result: { isError?: boolean; structuredContent: { task: { id: string } } } };
  assert.notEqual(response.result.isError, true);
  const id = response.result.structuredContent.task.id;
  await f.completed(id);
  const own = await (await f.tool(first, 'get_ai_task', { id })).json() as { result: { isError?: boolean } };
  assert.notEqual(own.result.isError, true);
  const foreign = await (await f.tool(second, 'get_ai_task', { id })).json() as { result: { isError?: boolean } };
  assert.equal(foreign.result.isError, true);
  const otherTasks = await (await f.tool(second, 'list_ai_tasks')).json() as { result: { structuredContent: { tasks: unknown[] } } };
  assert.deepEqual(otherTasks.result.structuredContent.tasks, []);
  assert.equal((await f.restTool(first, 'list_ai_tasks')).status, 403, 'OAuth does not grant the machine REST API');
  f.oauth.disconnect(f.oauth.assertCurrent(first).grantId);
  const revoked = await f.tool(first, 'get_ai_task', { id });
  assert.equal(revoked.status, 401);
  assert.match(revoked.headers.get('www-authenticate') || '', /resource_metadata=/);
  assert.equal((await f.rpc(second)).status, 200, 'the other AI approval remains active');
  assert.equal(f.calls(), 1);
});

test('resetting the shared Connector key cannot transfer old task history to the replacement key', async t => {
  const f = await fixture(t);
  await f.owner('/api/outbound-ai/access', { allowSharedKey: true });
  const response = await f.restTool(masterKey, 'start_ai_task', taskInput('before-key-reset'));
  assert.equal(response.status, 200);
  const { task } = await response.json() as { task: { id: string } };
  await f.completed(task.id);
  const reset = await f.owner('/api/settings/pipeline-key/reset', { confirmed: true });
  assert.equal(reset.status, 200);
  const { apiKey } = await reset.json() as { apiKey: string };
  assert.notEqual(apiKey, masterKey);
  assert.equal((await f.restTool(masterKey, 'get_ai_task', { id: task.id })).status, 401);
  assert.equal((await f.restTool(apiKey, 'get_ai_task', { id: task.id })).status, 404);
  const replacementHistory = await f.restTool(apiKey, 'list_ai_tasks');
  assert.equal(replacementHistory.status, 200);
  assert.deepEqual(await replacementHistory.json(), { tasks: [] });
  assert.equal((await f.owner(`/api/outbound-ai/tasks/${task.id}`)).status, 200);
  assert.equal(f.calls(), 1);
});
