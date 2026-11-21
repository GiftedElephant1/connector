import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { OnePasswordActions, type OnePasswordMachineService } from '../server/onepassword-tools';
import type { OnePasswordUseResult } from '../server/onepassword-types';
import { ProviderError } from '../server/provider-types';
import type { AppConfig } from '../server/config';
import { Store } from '../server/store';
import { Pipeline } from '../server/pipeline';
import { mountPipeline } from '../server/pipeline-http';
import { WorkspaceAccounts } from '../server/workspace-accounts';
import { McpOAuth } from '../server/mcp-oauth';

const masterKey = 'test-onepassword-general-key-123456789012345';
const generalPrincipal = `key:${createHash('sha256').update(masterKey).digest('hex')}`;
const privateValue = 'fixture-secret-must-never-reach-an-ai';
const publicLink = { id: 'approved-connection', name: 'Mailchimp account', target: 'Mailchimp' };

class FakeOnePassword implements OnePasswordMachineService {
  readonly allowed = new Set<string>();
  applications = 0;
  lastPrincipal?: string;
  beforeApply?: () => Promise<void>;
  hasAccess(principal: string) { return this.allowed.has(principal); }
  visibleLinks(principal: string) {
    return { links: this.hasAccess(principal) ? [{ ...publicLink, privateValue }] : [] };
  }
  async use(id: string, principal: string, assertCurrent: () => void): Promise<OnePasswordUseResult> {
    assertCurrent();
    if (!this.hasAccess(principal) || id !== publicLink.id) throw new ProviderError('This connection is not approved for this AI.', 403);
    await this.beforeApply?.();
    assertCurrent();
    if (!this.hasAccess(principal)) throw new ProviderError('This connection is not approved for this AI.', 403);
    this.applications++;
    this.lastPrincipal = principal;
    const result = { ...publicLink, status: 'applied' as const, message: 'The approved account was connected.', privateValue };
    return result;
  }
}

test('1Password actions expose only approved metadata and apply fixed IDs without returning credentials', async () => {
  const service = new FakeOnePassword();
  service.allowed.add(generalPrincipal);
  const actions = new OnePasswordActions(service, generalPrincipal, () => {});
  assert.deepEqual(actions.list(), { links: [publicLink] });
  assert.deepEqual(Object.keys(actions.tools()).sort(), ['list_onepassword_connections', 'use_onepassword_connection']);
  assert.deepEqual(actions.definitions().map(action => action.id), ['list-connections', 'use-connection']);
  assert.equal(actions.connections()[0].provider, '1password');
  const result = await actions.use({ id: publicLink.id, confirmed: true });
  assert.equal(result.status, 'applied');
  assert.equal(service.lastPrincipal, generalPrincipal);
  assert.equal(service.applications, 1);
  assert.equal(JSON.stringify({ listed: actions.list(), result }).includes(privateValue), false);
  const classic = await actions.run('list-connections', {}, undefined);
  assert.deepEqual(classic.result.items, [publicLink]);
  assert.equal(JSON.stringify(await actions.run('use-connection', { id: publicLink.id }, true)).includes(privateValue), false);
});

test('1Password actions reject arbitrary destinations, secret lookup, unknown IDs and missing confirmation', async () => {
  const service = new FakeOnePassword(); service.allowed.add(generalPrincipal);
  const actions = new OnePasswordActions(service, generalPrincipal, () => {});
  for (const input of [
    { id: publicLink.id }, { id: publicLink.id, confirmed: false },
    { id: publicLink.id, confirmed: true, target: 'https://attacker.example' },
    { id: publicLink.id, confirmed: true, reference: 'op://vault/item/password' },
    { id: 'op://vault/item/password', confirmed: true },
    { id: 'another-connection', confirmed: true },
  ]) await assert.rejects(actions.use(input));
  await assert.rejects(actions.run('use-connection', { id: publicLink.id, url: 'https://attacker.example' }, true));
  await assert.rejects(actions.run('read-secret', { id: publicLink.id }, true), /not supported/);
  await assert.rejects(actions.run('list-connections', { vault: 'private-vault' }, undefined));
  assert.equal(service.applications, 0);
});

test('1Password action access is checked dynamically before and after awaited work', async () => {
  const service = new FakeOnePassword();
  let authenticated = true;
  const actions = new OnePasswordActions(service, generalPrincipal, () => { if (!authenticated) throw new ProviderError('Authentication revoked.', 401); });
  assert.deepEqual(actions.connections(), []);
  assert.deepEqual(actions.definitions(), []);
  assert.deepEqual(actions.tools(), {});
  await assert.rejects(actions.use({ id: publicLink.id, confirmed: true }), /not enabled/);
  service.allowed.add(generalPrincipal);
  const previouslyDiscovered = actions.tools();
  service.beforeApply = async () => { service.allowed.delete(generalPrincipal); };
  await assert.rejects(actions.use({ id: publicLink.id, confirmed: true }), /not enabled/);
  assert.equal(service.applications, 0);
  await assert.rejects(previouslyDiscovered.list_onepassword_connections!.run(), /not enabled/);
  service.allowed.add(generalPrincipal);
  service.beforeApply = async () => { authenticated = false; };
  await assert.rejects(actions.use({ id: publicLink.id, confirmed: true }), /Authentication revoked/);
  assert.equal(service.applications, 0);
});

async function fixture(t: TestContext) {
  const config: AppConfig = { origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, password: 'test-workspace-password',
    encryptionKey: Buffer.alloc(32, 119), databasePath: ':memory:', secureCookies: false, pipelineKey: masterKey };
  const store = new Store(':memory:', config.encryptionKey);
  const accounts = new WorkspaceAccounts(config, store, {});
  const workspaceProfile = accounts.createProfile({ name: 'Google-only', bindings: [] });
  const oauth = new McpOAuth(config, store, accounts);
  const service = new FakeOnePassword();
  const app = express();
  mountPipeline(app, config, store, new Pipeline(store, {}), {}, { accounts, oauth, onepassword: service });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  config.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  });
  const request = (key: string, path: string, body?: unknown) => fetch(`${config.origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let rpcId = 0;
  const rpc = (key: string, method: string, params: unknown = {}) => request(key, '/mcp', { jsonrpc: '2.0', id: ++rpcId, method, params });
  const tool = (key: string, name: string, args: unknown = {}) => rpc(key, 'tools/call', { name, arguments: args });
  const grant = () => {
    const client = oauth.register({ client_name: 'Fixture AI', redirect_uris: ['https://fixture-ai.example/callback'] });
    const verifier = 'v'.repeat(64);
    const pending = new URL(oauth.start({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })).searchParams.get('authorize')!;
    const session = store.createSession(); oauth.consent(pending, session);
    const code = new URL(oauth.approve(pending, session, { approve: true, workspaceProfileId: workspaceProfile.profile.id }).redirectUrl).searchParams.get('code')!;
    const token = oauth.token({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code, code_verifier: verifier }).access_token;
    return { token, id: oauth.assertCurrent(token).grantId };
  };
  return { config, store, service, accounts, oauth, workspaceKey: workspaceProfile.apiKey, request, rpc, tool, grant };
}

type ToolCatalog = { tools: { name: string }[] };
type Connections = { connections: { provider: string }[] };
type RpcResponse = { result: { tools: { name: string }[]; isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] } };

test('REST and MCP discover 1Password only for an approved general key, including established actions', async t => {
  const f = await fixture(t);
  const catalog = async () => (await (await f.request(masterKey, '/api/v1/tools')).json() as ToolCatalog).tools.map(tool => tool.name);
  assert.equal((await catalog()).includes('use_onepassword_connection'), false);
  assert.equal((await f.request(masterKey, '/api/v1/tools/use_onepassword_connection', { id: publicLink.id, confirmed: true })).status, 404);
  f.service.allowed.add(generalPrincipal);
  assert.equal((await catalog()).includes('use_onepassword_connection'), true);
  const listed = await (await f.request(masterKey, '/api/v1/connections')).json() as Connections;
  assert.ok(listed.connections.some(connection => connection.provider === '1password'));
  const rpcList = await (await f.rpc(masterKey, 'tools/list')).json() as RpcResponse;
  assert.ok(rpcList.result.tools.some(tool => tool.name === 'list_onepassword_connections'));
  const read = await f.request(masterKey, '/api/v1/tools/list_onepassword_connections', {});
  assert.deepEqual(await read.json(), { links: [publicLink] });
  assert.equal((await f.request(masterKey, '/api/v1/actions/1password/use-connection', { values: { id: publicLink.id } })).status, 400);
  const applied = await f.request(masterKey, '/api/v1/actions/1password/use-connection', { values: { id: publicLink.id }, confirmed: true });
  assert.equal(applied.status, 200);
  assert.equal((await applied.text()).includes(privateValue), false);
  assert.equal(f.service.applications, 1);
  f.service.allowed.clear();
  assert.equal((await catalog()).includes('use_onepassword_connection'), false);
  const removed = await (await f.request(masterKey, '/api/v1/connections')).json() as Connections;
  assert.equal(removed.connections.some(connection => connection.provider === '1password'), false);
  assert.deepEqual(await (await f.request(masterKey, '/api/v1/actions/1password')).json(), { actions: [] });
});

test('Workspace profile keys never gain 1Password tools or actions even if mistakenly allowlisted', async t => {
  const f = await fixture(t);
  f.service.allowed.add(generalPrincipal);
  f.service.allowed.add(`key:${createHash('sha256').update(f.workspaceKey).digest('hex')}`);
  const catalog = await (await f.request(f.workspaceKey, '/api/v1/tools')).json() as ToolCatalog;
  assert.ok(catalog.tools.every(tool => !tool.name.includes('onepassword')));
  assert.equal((await f.request(f.workspaceKey, '/api/v1/tools/use_onepassword_connection', { id: publicLink.id, confirmed: true })).status, 404);
  assert.equal((await f.request(f.workspaceKey, '/api/v1/actions/1password/use-connection', { values: { id: publicLink.id }, confirmed: true })).status, 403);
  const mcp = await (await f.rpc(f.workspaceKey, 'tools/list')).json() as RpcResponse;
  assert.ok(mcp.result.tools.every(tool => !tool.name.includes('onepassword')));
  assert.equal(f.service.applications, 0);
});

test('OAuth 1Password access is bound to its approved grant without broadening platform or outbound access', async t => {
  const f = await fixture(t);
  const approved = f.grant(); const other = f.grant();
  f.service.allowed.add(`oauth:${approved.id}`);
  const catalog = await (await f.rpc(approved.token, 'tools/list')).json() as RpcResponse;
  const names = catalog.result.tools.map(tool => tool.name);
  assert.ok(names.includes('use_onepassword_connection'));
  assert.ok(names.includes('list_connections'));
  assert.equal(names.includes('schedule_post'), false);
  assert.equal(names.includes('start_ai_task'), false);
  const otherCatalog = await (await f.rpc(other.token, 'tools/list')).json() as RpcResponse;
  assert.equal(otherCatalog.result.tools.some(tool => tool.name.includes('onepassword')), false);
  const applied = await (await f.tool(approved.token, 'use_onepassword_connection', { id: publicLink.id, confirmed: true })).json() as RpcResponse;
  assert.equal(applied.result.isError, undefined);
  assert.equal(applied.result.structuredContent?.status, 'applied');
  assert.equal(JSON.stringify(applied).includes(privateValue), false);
  assert.equal(f.service.lastPrincipal, `oauth:${approved.id}`);
  const blocked = await (await f.tool(approved.token, 'run_action', { provider: 'x', action: 'publish', values: {}, confirmed: true })).json() as RpcResponse;
  assert.equal(blocked.result.isError, true);
  assert.equal((await f.request(approved.token, '/api/v1/tools/list_onepassword_connections', {})).status, 403);
  f.service.allowed.delete(`oauth:${approved.id}`);
  const revoked = await (await f.rpc(approved.token, 'tools/list')).json() as RpcResponse;
  assert.equal(revoked.result.tools.some(tool => tool.name.includes('onepassword')), false);
});

test('renewed authentication is required before applying a credential after key reset or OAuth revocation', async t => {
  const f = await fixture(t);
  f.service.allowed.add(generalPrincipal);
  f.service.beforeApply = async () => { f.config.pipelineKey = 'replacement-general-key-12345678901234567890'; };
  const reset = await f.request(masterKey, '/api/v1/tools/use_onepassword_connection', { id: publicLink.id, confirmed: true });
  assert.equal(reset.status, 401);
  assert.equal(f.service.applications, 0);
  const approved = f.grant(); f.service.allowed.add(`oauth:${approved.id}`);
  f.service.beforeApply = async () => { f.oauth.disconnect(approved.id); };
  const revoked = await (await f.tool(approved.token, 'use_onepassword_connection', { id: publicLink.id, confirmed: true })).json() as RpcResponse;
  assert.equal(revoked.result.isError, true);
  assert.equal(f.service.applications, 0);
});
