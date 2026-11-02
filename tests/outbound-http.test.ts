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
const aiTools = ['cancel_ai_task', 'get_ai_task', 'list_ai_agents', 'list_ai_tasks', 'start_ai_task'];

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'connector-outbound-http-'));
  const config: AppConfig = { origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000,
    password: 'test-owner-workspace-password', encryptionKey: Buffer.alloc(32, 94),
    databasePath: join(directory, 'test.sqlite'), secureCookies: false, pipelineKey: masterKey };
  const store = new Store(config.databasePath, config.encryptionKey);
  let calls = 0;
  const outbound = new OutboundAI(store, config.databasePath, {
    localRun: async () => { calls++; return { result: 'Fixture answer without external calls' }; },
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
  return { config, store, outbound, oauth, request, owner, cookie, rpc, tool, restTool, grant, workspaceKey, completed, calls: () => calls };
}

const taskInput = (requestId: string) => ({ provider: 'claude', prompt: 'Explain the supplied phrase in plain language.', confirmed: true, requestId });

test('outbound setup and credentials require an owner session and CSRF protection', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/outbound-ai')).status, 401);
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
  }
  assert.equal((await f.restTool(f.workspaceKey, 'start_ai_task', taskInput('workspace-denied'))).status, 404);
  assert.equal((await f.restTool(existing, 'start_ai_task', taskInput('oauth-rest-denied'))).status, 403);
  assert.equal(f.calls(), 0);
});

test('outbound-only OAuth grants expose exactly delegation tools, isolate receipts, and stop access after revocation', async t => {
  const f = await fixture(t);
  const first = f.grant({ outbound: true });
  const second = f.grant({ outbound: true });
  const listing = await f.rpc(first);
  assert.equal(listing.status, 200);
  const tools = await listing.json() as { result: { tools: { name: string }[] } };
  assert.deepEqual(tools.result.tools.map(tool => tool.name).sort(), aiTools);
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
