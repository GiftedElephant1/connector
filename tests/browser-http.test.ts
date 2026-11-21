import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app';
import type { AppConfig } from '../server/config';
import { Store } from '../server/store';
import { WorkspaceAccounts } from '../server/workspace-accounts';
import { McpOAuth } from '../server/mcp-oauth';
import type { BrowserDriver, BrowserRuntime, BrowserVault } from '../server/browser-types';

const key = 'browser-fixture-connector-key-12345678901234567890';
const principal = `key:${createHash('sha256').update(key).digest('hex')}`;
const password = 'private-browser-password-fixture';
const login = { accountId: 'a'.repeat(26), vaultId: 'b'.repeat(26), itemId: 'c'.repeat(26),
  title: 'Work login', accountName: 'Work', vaultName: 'Shared', origins: ['https://example.com'] };

async function fixture(t: TestContext) {
  const config: AppConfig = { origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000,
    password: 'browser-owner-fixture', encryptionKey: Buffer.alloc(32, 71), databasePath: ':memory:', secureCookies: false, pipelineKey: key };
  const store = new Store(':memory:', config.encryptionKey);
  const counters = { launches: 0, fills: 0, closes: 0 };
  const runtime: BrowserRuntime = {
    check: async () => ({ installed: true, name: 'Fixture browser', message: 'Browser available.' }),
    launch: async () => {
      counters.launches++;
      let origin = '', filled = false;
      const driver: BrowserDriver = {
        origin: () => origin,
        navigate: async (url, guard) => { guard(); origin = new URL(url).origin; },
        snapshot: async guard => { guard(); return { origin, title: 'Fixture page', text: filled ? `echo ${password}` : 'Sign in', elements: [{ ref: 'button-one', role: 'button', name: 'Continue' }] }; },
        click: async (_ref, guard) => { guard(); }, type: async (_ref, _text, guard) => { guard(); },
        fillLogin: async (expected, credential, guard) => {
          guard(); assert.equal(origin, expected); assert.equal(credential.password, password); filled = true; counters.fills++;
          return { filled: 'username_and_password' };
        },
        close: async () => { counters.closes++; },
      };
      return driver;
    },
  };
  const vault: BrowserVault = {
    browserLogins: async (_executable, origin, guard) => { guard?.(); assert.equal(origin, login.origins[0]); return [login]; },
    browserCredential: async () => ({ origins: login.origins, username: 'fixture-account', password }),
  };
  const app = createApp(config, store, undefined, {}, undefined, { browserVault: vault, browserRuntime: runtime });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); listening.once('error', reject);
  });
  config.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = `connector_session=${store.createSession()}`;
  const owner = (path: string, body?: unknown, method = 'POST', authorized = true, csrf = true) => fetch(`${config.origin}${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: { 'content-type': 'application/json', ...(authorized ? { cookie } : {}), ...(csrf ? { 'x-connector-request': '1', origin: config.origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const machine = (token: string, path: string, body?: unknown) => fetch(`${config.origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const configure = (principals: string[], enabled = true) => owner('/api/browser', { enabled, browser: 'auto', principals }, 'PUT');
  const accounts = new WorkspaceAccounts(config, store, {});
  const profile = accounts.createProfile({ name: 'Google only', bindings: [] });
  const oauth = new McpOAuth(config, store, accounts);
  const grant = () => {
    const client = oauth.register({ client_name: 'Browser fixture AI', redirect_uris: ['https://fixture-ai.example/callback'] });
    const verifier = 'v'.repeat(64);
    const pending = new URL(oauth.start({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })).searchParams.get('authorize')!;
    const session = store.createSession(); oauth.consent(pending, session);
    const code = new URL(oauth.approve(pending, session, { approve: true, workspaceProfileId: profile.profile.id }).redirectUrl).searchParams.get('code')!;
    const token = oauth.token({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code, code_verifier: verifier }).access_token;
    return { token, id: `oauth:${oauth.assertCurrent(token).grantId}` };
  };
  let rpcId = 0;
  const rpc = (token: string, method: string, params: unknown = {}) => machine(token, '/mcp', { jsonrpc: '2.0', id: ++rpcId, method, params });
  t.after(async () => {
    await app.locals.managedBrowser.close(); await app.locals.outboundAI.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  });
  return { config, store, counters, owner, machine, configure, profile, grant, rpc };
}

test('browser owner settings require session, CSRF and explicit existing principal approval', async t => {
  const f = await fixture(t);
  assert.equal((await f.owner('/api/browser', undefined, 'GET', false)).status, 401);
  assert.equal((await f.owner('/api/browser', { enabled: true, browser: 'auto', principals: [principal] }, 'PUT', true, false)).status, 403);
  assert.equal((await f.configure([principal])).status, 409);
  assert.equal((await f.owner('/api/onepassword', { enabled: true }, 'PUT')).status, 200);
  assert.equal((await f.configure(['key:unknown'])).status, 400);
  assert.equal((await f.configure([principal])).status, 200);
  const state = await (await f.owner('/api/browser')).json();
  assert.equal(state.enabled, true); assert.deepEqual(state.principals, [principal]); assert.equal(state.sessions.length, 0);
  assert.equal(f.counters.launches, 0);
  assert.equal((await f.machine(key, '/api/browser')).status, 401);
});

test('an approved REST caller opens a browser and signs in without per-item links or password responses', async t => {
  const f = await fixture(t);
  const catalog = async () => (await (await f.machine(key, '/api/v1/tools')).json()).tools.map((tool: { name: string }) => tool.name);
  assert.equal((await catalog()).includes('browser_open'), false);
  await f.owner('/api/onepassword', { enabled: true }, 'PUT'); await f.configure([principal]);
  assert.ok((await catalog()).includes('browser_sign_in'));
  const connections = await (await f.machine(key, '/api/v1/connections')).json();
  assert.ok(connections.connections.some((row: { provider: string }) => row.provider === 'browser'));
  assert.equal((await f.machine(key, '/api/v1/tools/browser_open', { url: 'https://example.com' })).status, 400);
  const opened = await f.machine(key, '/api/v1/tools/browser_open', { url: 'https://example.com', confirmed: true });
  assert.equal(opened.status, 200); const { sessionId } = await opened.json();
  const signed = await f.machine(key, '/api/v1/tools/browser_sign_in', { sessionId, confirmed: true });
  assert.equal(signed.status, 200); assert.equal((await signed.text()).includes(password), false); assert.equal(f.counters.fills, 1);
  const snapshot = await f.machine(key, '/api/v1/tools/browser_snapshot', { sessionId });
  const text = await snapshot.text(); assert.ok(text.includes('[redacted]')); assert.equal(text.includes(password), false);
  const profileCatalog = await (await f.machine(f.profile.apiKey, '/api/v1/tools')).json();
  assert.equal(profileCatalog.tools.some((tool: { name: string }) => tool.name.startsWith('browser_')), false);
  assert.equal((await f.machine(f.profile.apiKey, '/api/v1/tools/browser_snapshot', { sessionId })).status, 404);
  const actions = await (await f.machine(key, '/api/v1/actions/browser')).json(); assert.ok(actions.actions.length >= 7);
  await f.configure([], false); assert.equal(f.counters.closes, 1);
  assert.equal((await catalog()).includes('browser_open'), false);
  assert.equal((await f.machine(key, '/api/v1/tools/browser_snapshot', { sessionId })).status, 404);
});

test('browser OAuth access is explicit and does not grant platform writes, delegation, or access to another caller session', async t => {
  const f = await fixture(t); const allowed = f.grant(), other = f.grant();
  await f.owner('/api/onepassword', { enabled: true }, 'PUT'); await f.configure([principal, allowed.id]);
  const allowedTools = await (await f.rpc(allowed.token, 'tools/list')).json();
  const names = allowedTools.result.tools.map((tool: { name: string }) => tool.name);
  assert.ok(names.includes('browser_open')); assert.ok(names.includes('list_actions'));
  assert.equal(names.includes('schedule_post'), false); assert.equal(names.includes('start_ai_task'), false);
  const otherTools = await (await f.rpc(other.token, 'tools/list')).json();
  assert.equal(otherTools.result.tools.some((tool: { name: string }) => tool.name.startsWith('browser_')), false);
  const opened = await (await f.machine(key, '/api/v1/tools/browser_open', { url: 'https://example.com', confirmed: true })).json();
  const cross = await (await f.rpc(allowed.token, 'tools/call', { name: 'browser_snapshot', arguments: { sessionId: opened.sessionId } })).json();
  assert.equal(cross.result.isError, true);
  const own = await (await f.rpc(allowed.token, 'tools/call', { name: 'browser_open', arguments: { url: 'https://example.com', confirmed: true } })).json();
  assert.equal(own.result.isError, undefined); assert.ok(own.result.structuredContent.sessionId !== opened.sessionId);
  assert.equal((await f.machine(allowed.token, '/api/v1/tools/browser_open', { url: 'https://example.com', confirmed: true })).status, 403);
});
