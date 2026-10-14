import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ActionAdapter } from '../server/action-types.ts';
import type { AppConfig } from '../server/config.ts';
import { installation } from '../server/installation.ts';
import { Pipeline } from '../server/pipeline.ts';
import { mountPipeline } from '../server/pipeline-http.ts';
import { ProviderError } from '../server/provider-types.ts';
import { Store } from '../server/store.ts';
import { WorkspaceAccounts } from '../server/workspace-accounts.ts';
import { workspaceApps } from '../server/workspace-actions.ts';
import { WorkspacePipeline } from '../server/workspace-pipeline.ts';

const masterKey = 'test-master-key-12345678901234567890';
const env = { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'private-google-client-secret' };
const config: AppConfig = { origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, password: 'private-app-password', encryptionKey: Buffer.alloc(32, 33), databasePath: ':memory:', secureCookies: false, pipelineKey: masterKey };
const status = (code: number) => (error: unknown) => error instanceof ProviderError && error.status === code;

function fixture(t: TestContext, options: { disk?: boolean; execute?: ActionAdapter['execute'] } = {}) {
  const directory = options.disk ? mkdtempSync(join(tmpdir(), 'workspace-receipts-')) : undefined;
  const store = new Store(directory ? join(directory, 'connector.sqlite') : ':memory:', config.encryptionKey);
  t.after(() => { store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const requestedApps = ['sheets', 'gmail', 'docs'];
  const scopes = workspaceApps.filter(app => requestedApps.includes(app.id)).flatMap(app => app.scopes);
  store.writeSetting('workspace.accounts.v1', ['work', 'personal', 'hidden'].map(id => ({ id, email: `${id}@example.com`, name: `${id} account`, requestedApps, scopes, connectedAt: new Date().toISOString() })));
  for (const id of ['work', 'personal', 'hidden']) store.save(`google-workspace:${id}`, { accessToken: `private-access-${id}`, refreshToken: `private-refresh-${id}`, fields: { googleClientId: env.GOOGLE_CLIENT_ID } }, { accountId: id, accountName: `${id}@example.com`, resources: [] });
  const accounts = new WorkspaceAccounts(config, store, env);
  const grok = accounts.createProfile({ name: 'Grok', bindings: [{ accountId: 'work', apps: ['sheets'] }, { accountId: 'personal', apps: ['gmail'] }], defaultAccountId: 'work' });
  const claude = accounts.createProfile({ name: 'Claude', bindings: [{ accountId: 'personal', apps: ['gmail'] }], defaultAccountId: 'personal' });
  const seen: { token: string; text: string | undefined; app: string }[] = [];
  const adapters: ActionAdapter[] = requestedApps.flatMap(app => ['read', 'write'].map(id => ({
    provider: app,
    definition: { id, label: id, description: `Test ${app} ${id}`, group: 'publishing' as const, kind: id as 'read' | 'write', fields: id === 'read' ? [] : [{ name: 'text', label: 'Text', type: 'textarea' as const, required: true }] },
    execute: async (...args: Parameters<ActionAdapter['execute']>) => {
      seen.push({ token: args[0].accessToken, text: args[1].text, app });
      return options.execute ? options.execute(...args) : { summary: `private-result-${app}`, items: [{ id: 'created-content' }] };
    },
  })));
  const actionService = { getWorkspaceAction: (app: string, id: string) => adapters.find(adapter => adapter.provider === app && adapter.definition.id === id), listWorkspaceActions: (app: string) => adapters.filter(adapter => adapter.provider === app).map(adapter => adapter.definition) };
  const pipeline = new WorkspacePipeline(store, accounts, env, actionService);
  return { store, accounts, grok, claude, seen, pipeline, actionService, directory };
}

async function httpFixture(t: TestContext, options: Parameters<typeof fixture>[1] = {}) {
  const f = fixture(t, options);
  const app = express();
  const mountedConfig = { ...config };
  mountPipeline(app, mountedConfig, f.store, new Pipeline(f.store, env), env, { accounts: f.accounts, pipeline: f.pipeline });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (key: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let id = 0;
  const rpc = (key: string, method: string, params: unknown = {}) => api(key, '/mcp', { jsonrpc: '2.0', id: ++id, method, params }, 'POST', { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' });
  return { ...f, api, rpc, mountedConfig };
}

test('profile discovery exposes only allowed account/app metadata and selects the matching token', async t => {
  const f = fixture(t);
  assert.deepEqual(f.pipeline.accounts(f.grok.profile.id).map(account => ({ id: account.id, apps: account.apps })), [{ id: 'work', apps: ['sheets'] }, { id: 'personal', apps: ['gmail'] }]);
  assert.deepEqual(f.pipeline.accounts(f.claude.profile.id).map(account => account.id), ['personal']);
  assert.equal(JSON.stringify(f.pipeline.accounts(f.grok.profile.id)).includes('private-'), false);
  await f.pipeline.run(f.grok.profile.id, 'sheets', 'read', {});
  await f.pipeline.run(f.grok.profile.id, 'gmail', 'read', {}, undefined, undefined, 'personal');
  assert.deepEqual(f.seen.map(item => item.token), ['private-access-work', 'private-access-personal']);
  for (const [app, accountId] of [['gmail', 'work'], ['sheets', 'personal'], ['sheets', 'hidden']]) await assert.rejects(f.pipeline.run(f.grok.profile.id, app, 'read', {}, undefined, undefined, accountId), status(403));
  assert.throws(() => f.pipeline.definitions(f.claude.profile.id, 'sheets', 'work'), status(403));
  assert.equal(f.seen.length, 2);
});

test('account ambiguity is never resolved by guessing and unknown action fields fail before dispatch', async t => {
  const f = fixture(t);
  const profile = f.accounts.createProfile({ name: 'No default', bindings: [{ accountId: 'work', apps: ['sheets'] }, { accountId: 'personal', apps: ['sheets'] }] });
  await assert.rejects(f.pipeline.run(profile.profile.id, 'sheets', 'read', {}), status(409));
  assert.throws(() => f.pipeline.definitions(profile.profile.id, 'sheets'), status(409));
  for (const values of [{ text: 'Hi', accountId: 'hidden' }, { text: 1 }, {}, []]) await assert.rejects(f.pipeline.run(f.grok.profile.id, 'sheets', 'write', values, true, 'invalid-fields'), status(400));
  await f.pipeline.run(profile.profile.id, 'sheets', 'read', {}, undefined, undefined, 'personal');
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].token, 'private-access-personal');
});

test('writes need confirmation and IDs; profile-scoped receipts stay encrypted and outside legacy jobs', async t => {
  const f = fixture(t, { disk: true });
  const values = { text: 'private-unpublished-workspace-text' };
  for (const confirmed of [undefined, false, 'true']) await assert.rejects(f.pipeline.run(f.grok.profile.id, 'sheets', 'write', values, confirmed, 'workspace-request'), status(409));
  for (const requestId of [undefined, 'short', 'invalid id']) await assert.rejects(f.pipeline.run(f.grok.profile.id, 'sheets', 'write', values, true, requestId), status(400));
  const first = await f.pipeline.run(f.grok.profile.id, 'sheets', 'write', values, true, 'workspace-request');
  assert.deepEqual(await f.pipeline.run(f.grok.profile.id, 'sheets', 'write', values, true, 'workspace-request'), first);
  assert.equal(first.receipt?.status, 'succeeded');
  assert.deepEqual(f.store.jobs(), []);
  await assert.rejects(f.pipeline.run(f.grok.profile.id, 'sheets', 'write', { text: 'Changed content' }, true, 'workspace-request'), status(409));
  await f.pipeline.run(f.claude.profile.id, 'gmail', 'write', values, true, 'workspace-request');
  assert.equal(f.seen.length, 2, 'same request ID on another profile has an independent receipt');
  for (const file of readdirSync(f.directory!)) {
    const bytes = readFileSync(join(f.directory!, file));
    for (const secret of [values.text, 'private-result-sheets', 'private-access-work', 'workspace-request', f.grok.apiKey]) assert.equal(bytes.includes(Buffer.from(secret)), false, `${file} contains ${secret}`);
  }
});

test('permission edits are checked before returning cached results and after asynchronous credential retrieval', async t => {
  const f = fixture(t);
  await f.pipeline.run(f.grok.profile.id, 'sheets', 'write', { text: 'Hello' }, true, 'permission-retry');
  f.accounts.updateProfile(f.grok.profile.id, { name: 'Grok', bindings: [{ accountId: 'personal', apps: ['gmail'] }], defaultAccountId: 'personal' });
  await assert.rejects(f.pipeline.run(f.grok.profile.id, 'sheets', 'write', { text: 'Hello' }, true, 'permission-retry', 'work'), status(403));
  const original = f.accounts.getCredential.bind(f.accounts);
  t.mock.method(f.accounts, 'getCredential', async (accountId: string, app?: string) => {
    const credential = await original(accountId, app);
    f.accounts.updateProfile(f.claude.profile.id, { name: 'Claude', bindings: [] });
    return credential;
  });
  await assert.rejects(f.pipeline.run(f.claude.profile.id, 'gmail', 'write', { text: 'Must not send' }, true, 'revoked-before-send'), status(403));
  assert.equal(f.seen.length, 1);
});

test('ambiguous failures and recovered running receipts cannot replay writes', async t => {
  const f = fixture(t, { execute: async () => { throw new Error('private-internal-access-token'); } });
  await assert.rejects(f.pipeline.run(f.grok.profile.id, 'sheets', 'write', { text: 'Hello' }, true, 'uncertain-write'), error => error instanceof ProviderError && error.status === 502 && !error.message.includes('private-internal'));
  await assert.rejects(f.pipeline.run(f.grok.profile.id, 'sheets', 'write', { text: 'Hello' }, true, 'uncertain-write'), status(409));
  const requestId = 'crashed-writing';
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const setting = `workspace.receipt.v1.${digest([f.grok.profile.id, requestId])}`;
  f.store.writeSetting(setting, { requestId, accountId: 'work', app: 'sheets', action: 'write', fingerprint: digest(['work', 'sheets', 'write', { text: 'Interrupted' }]), status: 'running', createdAt: new Date().toISOString() });
  const restarted = new WorkspacePipeline(f.store, f.accounts, env, f.actionService);
  await assert.rejects(restarted.run(f.grok.profile.id, 'sheets', 'write', { text: 'Interrupted' }, true, requestId), status(409));
  assert.equal(f.store.readSetting<{ status: string }>(setting)?.status, 'uncertain');
  assert.equal(f.seen.length, 1);
});

test('concurrent duplicate requests claim an encrypted receipt before awaiting token refresh', async t => {
  const f = fixture(t);
  const original = f.accounts.getCredential.bind(f.accounts);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(f.accounts, 'getCredential', async (accountId: string, app?: string) => { await wait; return original(accountId, app); });
  const first = f.pipeline.run(f.grok.profile.id, 'sheets', 'write', { text: 'One submission' }, true, 'concurrent-write');
  await assert.rejects(f.pipeline.run(f.grok.profile.id, 'sheets', 'write', { text: 'One submission' }, true, 'concurrent-write'), status(409));
  release();
  await first;
  assert.equal(f.seen.length, 1);
});

test('REST strictly separates master and profile keys across actions, jobs, discovery, and Grok bot', async t => {
  const f = await httpFixture(t);
  for (const [path, method, body] of [
    ['/connections', 'GET', undefined], ['/actions/gmail', 'GET', undefined], ['/actions/gmail/send', 'POST', { values: {} }],
    ['/jobs', 'GET', undefined], ['/jobs', 'POST', {}], ['/jobs/some-job', 'DELETE', { confirmed: true }], ['/bot/turn', 'POST', { messages: [] }],
  ] as const) assert.equal((await f.api(f.grok.apiKey, `/api/v1${path}`, body, method)).status, 403, path);
  for (const name of ['list_connections', 'list_actions', 'list_jobs', 'run_action', 'schedule_post', 'cancel_job']) assert.equal((await f.api(f.grok.apiKey, `/api/v1/tools/${name}`, {})).status, 404, name);
  for (const path of ['/workspace/accounts', '/workspace/actions/sheets']) assert.equal((await f.api(masterKey, `/api/v1${path}`)).status, 403);
  for (const name of ['list_workspace_accounts', 'list_workspace_actions', 'run_workspace_action']) assert.equal((await f.api(masterKey, `/api/v1/tools/${name}`, {})).status, 404);
  const result = await f.api(f.grok.apiKey, '/api/v1/workspace/actions/sheets/read', { values: {} });
  assert.equal(result.status, 200);
  const discovery = await (await f.api(f.grok.apiKey, '/api/v1/workspace/accounts')).text();
  for (const secret of ['hidden@example.com', 'private-access', f.grok.apiKey, f.claude.apiKey, 'requestedApps', 'refreshToken']) assert.equal(discovery.includes(secret), false);
  assert.equal((await f.api(f.claude.apiKey, '/api/v1/workspace/actions/sheets/read', { accountId: 'work', values: {} })).status, 403);
  assert.equal((await f.api(f.grok.apiKey, '/api/v1/workspace/actions/sheets/read', { accountId: 'hidden', values: {} })).status, 403);
  assert.equal((await f.api(f.grok.apiKey, '/api/v1/workspace/actions/sheets/read', { values: {}, profileId: f.claude.profile.id })).status, 400);
  assert.equal(f.seen.length, 1);
});

test('MCP tool discovery and calls use only the current profile, while the master exposes legacy tools', async t => {
  const f = await httpFixture(t);
  const initialization = await (await f.rpc(f.grok.apiKey, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json() as { result: { serverInfo: { version: string } } };
  assert.equal(initialization.result.serverInfo.version, installation.version);
  const profileTools = await (await f.rpc(f.grok.apiKey, 'tools/list')).json() as { result: { tools: { name: string }[] } };
  assert.deepEqual(profileTools.result.tools.map(tool => tool.name).sort(), ['list_workspace_accounts', 'list_workspace_actions', 'run_workspace_action']);
  const legacyTools = await (await f.rpc(masterKey, 'tools/list')).json() as { result: { tools: { name: string }[] } };
  assert.equal(legacyTools.result.tools.some(tool => tool.name.includes('workspace')), false);
  for (const [key, name, args] of [
    [f.grok.apiKey, 'list_connections', {}], [f.grok.apiKey, 'list_jobs', {}], [masterKey, 'list_workspace_accounts', {}],
    [f.claude.apiKey, 'run_workspace_action', { app: 'sheets', action: 'read', accountId: 'work', values: {} }],
    [f.grok.apiKey, 'run_workspace_action', { app: 'sheets', action: 'read', accountId: 'hidden', values: {} }],
  ] as const) {
    const response = await (await f.rpc(key, 'tools/call', { name, arguments: args })).json() as { error?: unknown; result?: { isError?: boolean } };
    assert.ok(response.error || response.result?.isError, name);
  }
  const response = await (await f.rpc(f.grok.apiKey, 'tools/call', { name: 'run_workspace_action', arguments: { app: 'gmail', action: 'read', accountId: 'personal', values: {} } })).json() as { result: { isError?: boolean } };
  assert.notEqual(response.result.isError, true);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].token, 'private-access-personal');
});

test('rotated or deleted keys fail immediately and cannot continue a request waiting on credentials', async t => {
  const f = await httpFixture(t);
  const nextKey = f.accounts.rotateProfileKey(f.grok.profile.id).apiKey;
  for (const path of ['/api/v1/workspace/accounts', '/mcp']) assert.equal((await f.api(f.grok.apiKey, path)).status, 401);
  assert.equal((await f.api(nextKey, '/api/v1/workspace/accounts')).status, 200);
  const original = f.accounts.getCredential.bind(f.accounts);
  t.mock.method(f.accounts, 'getCredential', async (accountId: string, app?: string) => {
    const credential = await original(accountId, app);
    f.accounts.rotateProfileKey(f.grok.profile.id);
    return credential;
  });
  const rejected = await f.api(nextKey, '/api/v1/workspace/actions/sheets/write', { values: { text: 'Do not send' }, confirmed: true, requestId: 'rotated-in-flight' });
  assert.equal(rejected.status, 401);
  assert.equal(f.seen.length, 0);
  f.accounts.deleteProfile(f.claude.profile.id);
  assert.equal((await f.rpc(f.claude.apiKey, 'tools/list')).status, 401);
});

test('profile keys work without a master key and still reject foreign browser origins', async t => {
  const f = await httpFixture(t);
  f.mountedConfig.pipelineKey = undefined;
  assert.equal((await f.api(f.grok.apiKey, '/api/v1/workspace/accounts')).status, 200);
  assert.equal((await f.api(f.grok.apiKey, '/api/v1/workspace/accounts', undefined, 'GET', { origin: 'https://foreign.example' })).status, 403);
  f.accounts.rotateProfileKey(f.grok.profile.id);
  assert.equal((await f.api(f.grok.apiKey, '/api/v1/workspace/accounts')).status, 401);
});

test('revocation while Google is answering a read prevents the old profile from receiving its content', async t => {
  let answered!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { answered = resolve; });
  const outgoing = new Promise<void>(resolve => { started = resolve; });
  const f = await httpFixture(t, { execute: async () => {
    started();
    await pending;
    return { summary: 'private-content-from-pending-google-read' };
  } });
  const request = f.api(f.grok.apiKey, '/api/v1/workspace/actions/sheets/read', { values: {} });
  await outgoing;
  f.accounts.rotateProfileKey(f.grok.profile.id);
  answered();
  const response = await request;
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes('private-content-from-pending-google-read'), false);
});

test('an action waiting on credentials cannot resume across account reset and explicit reauthorization', async t => {
  const f = fixture(t);
  const savedAccounts = f.store.readSetting('workspace.accounts.v1');
  const credential = f.store.credential('google-workspace:work')!;
  const original = f.accounts.getCredential.bind(f.accounts);
  t.mock.method(f.accounts, 'getCredential', async (accountId: string, app?: string) => {
    const previous = await original(accountId, app);
    f.accounts.disconnect('work');
    f.store.writeSetting('workspace.accounts.v1', savedAccounts);
    f.store.save('google-workspace:work', credential, { accountId: 'work', accountName: 'work@example.com', resources: [] });
    f.accounts.updateProfile(f.grok.profile.id, { name: 'Grok', bindings: [{ accountId: 'work', apps: ['sheets'] }], defaultAccountId: 'work' });
    return previous;
  });
  await assert.rejects(f.pipeline.run(f.grok.profile.id, 'sheets', 'write', { text: 'Do not send an old request' }, true, 'reset-before-dispatch'), status(409));
  assert.equal(f.seen.length, 0);
});
