import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app';
import type { AppConfig } from '../server/config';
import * as providers from '../server/providers';
import { Store, hash } from '../server/store';
import { OnePasswordService, type OnePasswordCliAccess } from '../server/onepassword';
import type { OnePasswordLinkInput, OnePasswordSnapshot } from '../server/onepassword-types';

const secret = 'private-1password-credential-never-return';
const privateCliError = 'raw-CLI-output-contains-sensitive-material';
const accountId = 'a'.repeat(26), vaultId = 'b'.repeat(26), itemId = 'c'.repeat(26);
const input = (overrides: Partial<OnePasswordLinkInput> = {}): OnePasswordLinkInput => ({
  name: 'Mailchimp from my vault', accountId, vaultId, itemId, targetId: 'connection:mailchimp', fields: { apiKey: 'password' }, literals: {}, principals: [], ...overrides,
});
const cli = (overrides: Partial<OnePasswordCliAccess> = {}): OnePasswordCliAccess => ({
  check: async () => ({ installed: true, version: '2.42.0', message: 'CLI installed.' }),
  accounts: async () => [{ id: accountId, name: 'Personal' }], vaults: async () => [{ id: vaultId, name: 'Work' }],
  items: async () => [{ id: itemId, title: 'Saved login', category: 'LOGIN' }],
  fields: async () => [{ id: 'password', label: 'password', type: 'CONCEALED', purpose: 'PASSWORD' }, { id: 'username', label: 'username', type: 'STRING', purpose: 'USERNAME' }],
  readFields: async () => ({ password: secret, username: 'account-user' }), ...overrides,
});
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function service(t: TestContext, overrides: Partial<OnePasswordCliAccess> = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 9)); t.after(() => store.close());
  let principals = [{ id: 'key:allowed', label: 'Shared Connector key' }];
  const applied: Record<string, string>[] = [];
  const onepassword = new OnePasswordService(store, {
    catalog: () => [{ id: 'connection:mailchimp', label: 'Mailchimp connection', agentUsable: true, description: 'Test', fields: [{ key: 'apiKey', label: 'API key', secret: true, required: true, source: 'vault' }] }],
    prepare: () => ({ assertUnchanged() {}, async apply(values, assertCurrent) { assertCurrent(); applied.push(values); } }),
  }, () => principals, cli(overrides));
  onepassword.configure({ enabled: true });
  return { store, onepassword, applied, setPrincipals(value: typeof principals) { principals = value; } };
}
test('1Password links default to owner only, cannot accept commands or runtime controls, and return no field values', async t => {
  const f = service(t);
  const saved = await f.onepassword.saveLink(input(), () => {});
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.deepEqual(f.onepassword.visibleLinks('key:allowed'), { links: [] });
  const id = saved.links[0].id;
  await assert.rejects(f.onepassword.use(id, 'key:allowed'), /not available/);
  const result = await f.onepassword.use(id, 'owner');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(f.applied, [{ apiKey: secret }]);
  for (const bad of [input({ targetId: 'APP_ORIGIN' }), input({ fields: { executable: 'password' } }), input({ literals: { apiKey: secret } }), input({ principals: ['oauth:unapproved'] }), { ...input(), command: 'op read anything' }]) {
    await assert.rejects(f.onepassword.saveLink(bad, () => {}));
  }
  assert.throws(() => f.onepassword.configure({ enabled: true, executable: 'op && anything' }));
});
test('linked credentials require explicit access and do not transfer to a reset principal', async t => {
  const f = service(t);
  const snapshot = await f.onepassword.saveLink(input({ principals: ['key:allowed'] }), () => {});
  assert.equal(f.onepassword.hasAccess('key:allowed'), true);
  await f.onepassword.use(snapshot.links[0].id, 'key:allowed');
  assert.equal(f.applied.length, 1);
  assert.equal(f.onepassword.snapshot().links[0].lastUsedAt !== undefined, true);
  f.setPrincipals([{ id: 'key:replacement', label: 'Replacement key' }]);
  assert.equal(f.onepassword.hasAccess('key:allowed'), false);
  assert.equal(f.onepassword.hasAccess('key:replacement'), false);
  await assert.rejects(f.onepassword.use(snapshot.links[0].id, 'key:allowed'), /not available/);
});
for (const action of ['remove', 'disable', 'permissions', 'logout', 'key-reset'] as const) {
  test(`a ${action} during 1Password approval prevents credential application`, async t => {
    const entered = deferred(), waiting = deferred();
    const f = service(t, { readFields: async () => { entered.release(); await waiting.promise; return { password: secret }; } });
    const saved = await f.onepassword.saveLink(input({ principals: ['key:allowed'] }), () => {});
    const id = saved.links[0].id; let session = true;
    const pending = f.onepassword.use(id, 'key:allowed', () => { if (!session) throw new Error('Session ended'); });
    await entered.promise;
    if (action === 'remove') f.onepassword.remove(id);
    else if (action === 'disable') f.onepassword.configure({ enabled: false });
    else if (action === 'permissions') await f.onepassword.saveLink(input(), () => {}, id);
    else if (action === 'key-reset') f.setPrincipals([]);
    else session = false;
    waiting.release();
    await assert.rejects(pending);
    assert.equal(f.applied.length, 0);
  });
}
test('simultaneous uses of one destination do not race, and removed links do not delete imported credentials', async t => {
  const entered = deferred(), waiting = deferred();
  const f = service(t, { readFields: async () => { entered.release(); await waiting.promise; return { password: secret }; } });
  const first = (await f.onepassword.saveLink(input(), () => {})).links[0];
  const second = (await f.onepassword.saveLink(input({ name: 'Other reference' }), () => {})).links[1];
  const pending = f.onepassword.use(first.id, 'owner');
  await entered.promise;
  await assert.rejects(f.onepassword.use(second.id, 'owner'), /already being updated/);
  waiting.release(); await pending;
  f.onepassword.remove(first.id);
  assert.equal(f.applied.length, 1);
});

async function httpFixture(t: TestContext, options: { cli?: OnePasswordCliAccess; verify?: typeof providers.verifyConnection } = {}) {
  const config: AppConfig = { origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, password: 'owner-test-password', encryptionKey: Buffer.alloc(32, 8), databasePath: ':memory:', secureCookies: false, pipelineKey: 'machine-key-'.repeat(4) };
  const store = new Store(':memory:', config.encryptionKey);
  const env: NodeJS.ProcessEnv = {};
  let verified = 0;
  const app = createApp(config, store, { ...providers, verifyConnection: options.verify || (async (_id, credential) => {
    verified++; assert.equal(credential.accessToken, secret);
    return { accountName: 'Verified account', resources: [] };
  }) }, env, undefined, { onePasswordCli: options.cli || cli() });
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = store.createSession();
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') => fetch(`${base}${path}`, { method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const owner = (path: string, body?: unknown, method?: string) => request(path, body, { cookie: `connector_session=${session}`, 'x-connector-request': '1' }, method);
  const machine = (path: string, body?: unknown) => request(path, body, { authorization: `Bearer ${config.pipelineKey}` });
  await owner('/api/onepassword', { enabled: true }, 'PUT');
  const link = async (value = input()) => {
    const response = await owner('/api/onepassword/links', value);
    assert.equal(response.status, 200, await response.clone().text());
    const snapshot = await response.json() as OnePasswordSnapshot;
    return snapshot.links.at(-1)!;
  };
  return { config, store, env, request, owner, machine, link, session, verified: () => verified };
}
test('1Password owner endpoints require sessions and CSRF; general machine access does not browse the vault', async t => {
  const f = await httpFixture(t);
  for (const path of ['/api/onepassword', '/api/onepassword/accounts', '/api/onepassword/links']) {
    const body = path === '/api/onepassword' ? undefined : {};
    assert.equal((await f.request(path, body, { 'x-connector-request': '1' })).status, 401);
    assert.equal((await f.request(path, body, { 'x-connector-request': '1', authorization: `Bearer ${f.config.pipelineKey}` })).status, 401);
  }
  assert.equal((await f.request('/api/onepassword/accounts', {}, { cookie: `connector_session=${f.session}` })).status, 403);
  assert.equal((await f.request('/api/onepassword/accounts', {}, { cookie: `connector_session=${f.session}`, 'x-connector-request': '1', origin: 'https://foreign.example' })).status, 403);
  const tools = await (await f.machine('/api/v1/tools')).text();
  assert.equal(tools.includes('list_onepassword_connections'), false);
  assert.equal((await f.machine('/api/v1/tools/use_onepassword_connection', { id: 'unknown', confirmed: true })).status, 404);
});
test('owner-approved shared-key link applies credentials without values in REST/MCP metadata or results', async t => {
  const f = await httpFixture(t);
  const link = await f.link(input({ principals: [`key:${hash(f.config.pipelineKey!)}`] }));
  const discovery = await (await f.machine('/api/v1/connections')).text();
  assert.match(discovery, /1Password/);
  const list = await (await f.machine('/api/v1/tools/list_onepassword_connections', {})).text();
  assert.match(list, /Mailchimp/);
  for (const value of [secret, accountId, vaultId, itemId]) assert.equal(list.includes(value), false);
  assert.equal((await f.machine('/api/v1/tools/use_onepassword_connection', { id: link.id, confirmed: false })).status, 400);
  const response = await f.machine('/api/v1/tools/use_onepassword_connection', { id: link.id, confirmed: true });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(secret), false);
  assert.equal(f.store.credential('mailchimp')?.accessToken, secret);
  assert.equal((await (await f.owner('/api/onepassword')).text()).includes(secret), false);
  assert.equal(f.verified(), 1);
});
test('OAuth connection only gains credential links explicitly assigned to its own grant', async t => {
  const f = await httpFixture(t);
  const verifier = 'v'.repeat(64);
  const client = await (await f.request('/oauth/register', { redirect_uris: ['https://ai.example/callback'] })).json();
  const authorize = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://ai.example/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  const tokens: string[] = [];
  for (let index = 0; index < 2; index++) {
    const response = await f.request(`/oauth/authorize?${authorize}`);
    assert.equal(response.status, 302);
    const id = new URL(response.headers.get('location')!).searchParams.get('authorize')!;
    await f.owner(`/api/ai/authorize/${id}`);
    const consent = await (await f.owner(`/api/ai/authorize/${id}`, { approve: true, platforms: true })).json();
    const code = new URL(consent.redirectUrl).searchParams.get('code');
    const token = await (await f.request('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: 'https://ai.example/callback' })).json();
    tokens.push(token.access_token);
  }
  const connections = await (await f.owner('/api/ai/connectors')).json();
  const link = await f.link(input({ principals: [`oauth:${connections.grants[0].id}`] }));
  const rpc = (token: string, method: string, params: unknown) => f.request('/mcp', { jsonrpc: '2.0', id: 1, method, params }, {
    authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26',
  });
  assert.match(await (await rpc(tokens[0], 'tools/list', {})).text(), /list_onepassword_connections/);
  assert.doesNotMatch(await (await rpc(tokens[1], 'tools/list', {})).text(), /list_onepassword_connections/);
  const applied = await (await rpc(tokens[0], 'tools/call', { name: 'use_onepassword_connection', arguments: { id: link.id, confirmed: true } })).text();
  assert.match(applied, /applied/); assert.doesNotMatch(applied, new RegExp(secret));
  assert.equal(f.verified(), 1);
  const denied = await (await rpc(tokens[1], 'tools/call', { name: 'use_onepassword_connection', arguments: { id: link.id, confirmed: true } })).text();
  assert.match(denied, /error|isError/);
  assert.equal(f.verified(), 1);
});
test('provider disconnect during 1Password resolution prevents restoring its credential', async t => {
  const entered = deferred(), waiting = deferred();
  const f = await httpFixture(t, { cli: cli({ readFields: async () => { entered.release(); await waiting.promise; return { password: secret }; } }) });
  const link = await f.link();
  const pending = f.owner(`/api/onepassword/links/${link.id}/use`, { confirmed: true });
  await entered.promise;
  f.store.disconnect('mailchimp'); waiting.release();
  assert.equal((await pending).status, 409);
  assert.equal(f.store.credential('mailchimp'), null);
  assert.equal(f.verified(), 0);
});
test('provider disconnect during verification prevents saving and raw provider errors never escape', async t => {
  const entered = deferred(), waiting = deferred();
  const f = await httpFixture(t, { verify: async () => { entered.release(); await waiting.promise; return { accountName: 'Account', resources: [] }; } });
  const link = await f.link();
  const pending = f.owner(`/api/onepassword/links/${link.id}/use`, { confirmed: true });
  await entered.promise; f.store.disconnect('mailchimp'); waiting.release();
  assert.equal((await pending).status, 409);
  assert.equal(f.store.credential('mailchimp'), null);
  const bad = await httpFixture(t, { verify: async () => { throw new providers.ProviderError(`${privateCliError} ${secret}`); } });
  const badLink = await bad.link();
  const badResponse = await bad.owner(`/api/onepassword/links/${badLink.id}/use`, { confirmed: true });
  assert.equal(badResponse.status, 422);
  const body = await badResponse.text();
  assert.equal(body.includes(secret), false); assert.equal(body.includes(privateCliError), false);
});
test('a shared-key reset during credential verification preserves the authentication error and blocks the save', async t => {
  const entered = deferred(), waiting = deferred();
  const f = await httpFixture(t, { verify: async () => { entered.release(); await waiting.promise; return { accountName: 'Account', resources: [] }; } });
  const link = await f.link(input({ principals: [`key:${hash(f.config.pipelineKey!)}`] }));
  const pending = f.machine('/api/v1/tools/use_onepassword_connection', { id: link.id, confirmed: true });
  await entered.promise;
  const reset = await f.owner('/api/settings/pipeline-key/reset', { confirmed: true });
  assert.equal(reset.status, 200);
  waiting.release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes(secret), false);
  assert.equal(f.store.credential('mailchimp'), null);
});
test('non-platform credential targets preserve enablement and no secrets reach ordinary account summaries', async t => {
  const f = await httpFixture(t, { verify: async () => ({ accountName: `Provider echoed ${secret}`, resources: [{ id: secret, name: `Echo ${secret}`, type: 'account' }] }) });
  const link = await f.link();
  assert.equal((await f.owner(`/api/onepassword/links/${link.id}/use`, { confirmed: true })).status, 200);
  assert.equal(JSON.stringify(f.store.connection('mailchimp')).includes(secret), false);
  const cursor = await f.link(input({ targetId: 'outbound:cursor' }));
  assert.equal((await f.owner(`/api/onepassword/links/${cursor.id}/use`, { confirmed: true })).status, 200);
  const outbound = await (await f.owner('/api/outbound-ai')).json();
  assert.equal(outbound.providers.find((provider: { id: string }) => provider.id === 'cursor').enabled, false);
  assert.equal(outbound.providers.find((provider: { id: string }) => provider.id === 'cursor').hasApiKey, true);
  assert.equal(JSON.stringify(outbound).includes(secret), false);
});
test('application credentials import without OAuth bypass and concealed fields cannot become visible settings', async t => {
  const f = await httpFixture(t);
  const targetId = 'settings:google-workspace';
  const invalid = await f.owner('/api/onepassword/links', input({ targetId, fields: { GOOGLE_CLIENT_ID: 'password' } }));
  assert.equal(invalid.status, 400);
  const link = await f.link(input({ targetId, fields: { GOOGLE_CLIENT_ID: 'username', GOOGLE_CLIENT_SECRET: 'password' } }));
  const response = await f.owner(`/api/onepassword/links/${link.id}/use`, { confirmed: true });
  assert.equal(response.status, 200);
  assert.equal(f.env.GOOGLE_CLIENT_SECRET, secret);
  assert.equal((await (await f.owner('/api/settings')).text()).includes(secret), false);
  const workspace = await (await f.owner('/api/workspace')).json();
  assert.deepEqual(workspace.accounts, []);
  assert.equal(workspace.google.configured, true);
  assert.equal((await f.owner('/api/onepassword/links', input({ targetId, fields: { GOOGLE_CLIENT_SECRET: 'password' }, principals: [`key:${hash(f.config.pipelineKey!)}`] }))).status, 400);
});
