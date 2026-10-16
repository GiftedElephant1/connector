import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { ActionResult } from '../server/action-types.ts';
import type { AppConfig } from '../server/config.ts';
import { Pipeline } from '../server/pipeline.ts';
import { mountPipeline } from '../server/pipeline-http.ts';
import { ProviderError } from '../server/provider-types.ts';
import { Store } from '../server/store.ts';
import { WorkspaceAccounts } from '../server/workspace-accounts.ts';
import { workspaceApps } from '../server/workspace-actions.ts';
import { WorkspacePipeline } from '../server/workspace-pipeline.ts';

const realFetch = globalThis.fetch;
const readScope = 'https://www.googleapis.com/auth/drive.readonly';
const baselineScopes = workspaceApps.find(app => app.id === 'drive')!.scopes;
const env = { GOOGLE_CLIENT_ID: 'drive-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'private-drive-client-secret' };
const masterKey = 'private-general-connector-key-1234567890';
const config: AppConfig = { origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, password: 'private-dashboard-password', encryptionKey: Buffer.alloc(32, 47), databasePath: ':memory:', secureCookies: false, pipelineKey: masterKey };
const logo = Buffer.from(Array.from({ length: 65_536 }, (_, index) => index % 256));
const logoId = 'brand_kit-logo-1';
const sha256 = createHash('sha256').update(logo).digest('hex');
const metadata = { id: logoId, name: 'Vectre Pay logo.png', mimeType: 'image/png', size: String(logo.length), capabilities: { canDownload: true }, sha256Checksum: sha256 };
type StoredAccount = { id: string; email: string; name: string; requestedApps: string[]; scopes: string[]; connectedAt: string };
type RunResult = { result: ActionResult; receipt?: unknown };

function createStore(t: TestContext) {
  const store = new Store(':memory:', config.encryptionKey);
  t.after(() => store.close());
  const accounts = new WorkspaceAccounts(config, store, env);
  return { store, accounts, pipeline: new WorkspacePipeline(store, accounts, env) };
}

function fixture(t: TestContext, readonly = true) {
  const f = createStore(t);
  f.store.writeSetting('workspace.accounts.v1', ['work', 'personal', 'hidden'].map(id => ({
    id, email: `${id}@example.com`, name: id, requestedApps: ['drive'], scopes: [...baselineScopes, ...(readonly ? [readScope] : [])], connectedAt: new Date().toISOString(),
  })));
  for (const id of ['work', 'personal', 'hidden']) f.store.save(`google-workspace:${id}`, {
    accessToken: `private-access-${id}`, refreshToken: `private-refresh-${id}`, fields: { googleClientId: env.GOOGLE_CLIENT_ID },
  }, { accountId: id, accountName: `${id}@example.com`, resources: [] });
  const grok = f.accounts.createProfile({ name: 'Grok', bindings: [{ accountId: 'work', apps: ['drive'] }, { accountId: 'personal', apps: ['drive'] }], defaultAccountId: 'work' });
  const other = f.accounts.createProfile({ name: 'Other agent', bindings: [{ accountId: 'personal', apps: ['drive'] }], defaultAccountId: 'personal' });
  return { ...f, grok, other };
}

async function httpFixture(t: TestContext, readonly = true) {
  const f = fixture(t, readonly);
  const app = express();
  mountPipeline(app, { ...config }, f.store, new Pipeline(f.store, env), env, { accounts: f.accounts, pipeline: f.pipeline });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (key: string, path: string, body?: unknown, headers: Record<string, string> = {}) => realFetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let rpcId = 0;
  const rpc = (key: string, method: string, params: unknown = {}) => api(key, '/mcp', { jsonrpc: '2.0', id: ++rpcId, method, params }, { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' });
  return { ...f, api, rpc };
}

function mockDrive(t: TestContext, beforeMedia?: () => Promise<void>) {
  const calls: { url: URL; authorization: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(init?.redirect, 'error');
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url, authorization });
    if (url.pathname === '/drive/v3/files') return Response.json({ files: [metadata] });
    assert.equal(url.pathname, `/drive/v3/files/${logoId}`);
    if (url.searchParams.get('alt') === 'media') {
      await beforeMedia?.();
      return new Response(logo, { headers: { 'content-type': 'image/png', 'content-length': String(logo.length) } });
    }
    return Response.json(metadata);
  });
  return calls;
}

function assertDownload(output: RunResult) {
  assert.equal(output.receipt, undefined);
  const file = output.result.items?.[0];
  assert.ok(file);
  assert.equal(file.fileId, logoId);
  assert.equal(file.name, metadata.name);
  assert.equal(file.mimeType, 'image/png');
  assert.equal(file.size, logo.length);
  assert.equal(file.encoding, 'base64');
  assert.equal(typeof file.contentBase64, 'string');
  assert.deepEqual(Buffer.from(file.contentBase64 as string, 'base64'), logo);
  assert.equal(file.sha256, sha256);
}

function removeReadScope(store: Store, accountId = 'work') {
  const accounts = store.readSetting<StoredAccount[]>('workspace.accounts.v1')!;
  store.writeSetting('workspace.accounts.v1', accounts.map(account => account.id === accountId ? { ...account, scopes: account.scopes.filter(scope => scope !== readScope) } : account));
}

test('Drive downloads are discoverable and return exact binary bytes through REST without write receipts', async t => {
  const f = await httpFixture(t);
  const calls = mockDrive(t);
  const definitions = await (await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive')).json() as { actions: { id: string; kind: string; fields: { name: string }[] }[] };
  const download = definitions.actions.find(action => action.id === 'download-file');
  assert.equal(download?.kind, 'read');
  assert.deepEqual(download?.fields.map(field => field.name), ['fileId']);
  const requestId = 'drive-read-no-receipt';
  const response = await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/download-file', { values: { fileId: logoId }, requestId });
  assert.equal(response.status, 200);
  assertDownload(await response.json() as RunResult);
  assert.deepEqual(calls.map(call => call.authorization), ['Bearer private-access-work', 'Bearer private-access-work']);
  const receiptHash = createHash('sha256').update(JSON.stringify([f.grok.profile.id, requestId])).digest('hex');
  assert.equal(f.store.readSetting(`workspace.receipt.v1.${receiptHash}`), null);
  assert.deepEqual(f.store.jobs(), []);
});

test('MCP exposes and executes the Drive download action with the explicit account and untruncated bytes', async t => {
  const f = await httpFixture(t);
  const calls = mockDrive(t);
  const discovery = await (await f.rpc(f.grok.apiKey, 'tools/call', { name: 'list_workspace_actions', arguments: { app: 'drive', accountId: 'personal' } })).json() as { result: { structuredContent: { actions: { id: string }[] } } };
  assert.ok(discovery.result.structuredContent.actions.some(action => action.id === 'download-file'));
  const response = await (await f.rpc(f.grok.apiKey, 'tools/call', { name: 'run_workspace_action', arguments: { app: 'drive', action: 'download-file', accountId: 'personal', values: { fileId: logoId } } })).json() as {
    result: { isError?: boolean; structuredContent: RunResult; content: { type: string; text: string }[] };
  };
  assert.notEqual(response.result.isError, true);
  assertDownload(response.result.structuredContent);
  assertDownload(JSON.parse(response.result.content[0].text) as RunResult);
  assert.deepEqual(calls.map(call => call.authorization), ['Bearer private-access-personal', 'Bearer private-access-personal']);
});

test('legacy Drive grants retain listing and metadata while downloads explain how to grant file reading', async t => {
  const f = await httpFixture(t, false);
  const calls = mockDrive(t);
  assert.deepEqual(f.accounts.listAccounts().find(account => account.id === 'work')?.apps, ['drive']);
  assert.equal(f.accounts.listAccounts().find(account => account.id === 'work')?.driveDownloads, false);
  const discovery = await (await f.api(f.grok.apiKey, '/api/v1/workspace/accounts')).json() as { accounts: { id: string; apps: string[]; driveDownloads: boolean }[] };
  assert.equal(discovery.accounts.find(account => account.id === 'work')?.driveDownloads, false);
  assert.equal((await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/list-files', { values: {} })).status, 200);
  assert.equal((await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/read-file-metadata', { values: { fileId: logoId } })).status, 200);
  const denied = await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/download-file', { values: { fileId: logoId } });
  assert.equal(denied.status, 403);
  const error = await denied.text();
  assert.match(error, /permission.*read existing files/i);
  assert.match(error, /Change connected apps/);
  assert.equal(calls.length, 2, 'insufficient grants must fail before a download is sent to Google');
  assert.equal(f.accounts.resolveAgentKey(f.grok.apiKey)?.id, f.grok.profile.id);
});

test('Drive download account selection obeys the profile, explicit account, default, and general-key boundary', async t => {
  const f = await httpFixture(t);
  const calls = mockDrive(t);
  for (const [key, accountId] of [[f.grok.apiKey, 'hidden'], [f.other.apiKey, 'work'], [masterKey, 'work']]) {
    const response = await f.api(key, '/api/v1/workspace/actions/drive/download-file', { accountId, values: { fileId: logoId } });
    assert.equal(response.status, 403);
    assert.equal((await response.text()).includes(logo.toString('base64')), false);
  }
  const noDefault = f.accounts.createProfile({ name: 'Choose an account', bindings: [{ accountId: 'work', apps: ['drive'] }, { accountId: 'personal', apps: ['drive'] }] });
  assert.equal((await f.api(noDefault.apiKey, '/api/v1/workspace/actions/drive/download-file', { values: { fileId: logoId } })).status, 409);
  assert.equal(calls.length, 0);
  assertDownload(await (await f.api(noDefault.apiKey, '/api/v1/workspace/actions/drive/download-file', { accountId: 'personal', values: { fileId: logoId } })).json() as RunResult);
  assert.deepEqual(calls.map(call => call.authorization), ['Bearer private-access-personal', 'Bearer private-access-personal']);
});

for (const revoked of ['profile', 'key', 'scope'] as const) test(`revoking a Drive ${revoked} while Google downloads prevents returning file bytes`, async t => {
  const f = await httpFixture(t);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const mediaStarted = new Promise<void>(resolve => { started = resolve; });
  mockDrive(t, async () => { started(); await waiting; });
  const pending = f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/download-file', { values: { fileId: logoId } });
  await mediaStarted;
  if (revoked === 'profile') f.accounts.updateProfile(f.grok.profile.id, { name: 'Grok', bindings: [] });
  if (revoked === 'key') f.accounts.rotateProfileKey(f.grok.profile.id);
  if (revoked === 'scope') removeReadScope(f.store);
  release();
  const response = await pending;
  assert.equal(response.status, revoked === 'key' ? 401 : 403);
  const body = await response.text();
  assert.equal(body.includes('contentBase64'), false);
  assert.equal(body.includes(logo.toString('base64')), false);
  assert.equal(body.includes(sha256), false);
});

test('Drive content grants are checked before credential retrieval and again when it finishes', async t => {
  const f = fixture(t, false);
  const calls = mockDrive(t);
  const original = f.accounts.getCredential.bind(f.accounts);
  const credentialMock = t.mock.method(f.accounts, 'getCredential', async (accountId: string, app?: string) => original(accountId, app));
  await assert.rejects(f.pipeline.run(f.grok.profile.id, 'drive', 'download-file', { fileId: logoId }), (error: unknown) => error instanceof ProviderError && error.status === 403);
  assert.equal(credentialMock.mock.callCount(), 0);
  const accounts = f.store.readSetting<StoredAccount[]>('workspace.accounts.v1')!;
  f.store.writeSetting('workspace.accounts.v1', accounts.map(account => ({ ...account, scopes: [...account.scopes, readScope] })));
  credentialMock.mock.mockImplementation(async (accountId: string, app?: string) => {
    const credential = await original(accountId, app);
    removeReadScope(f.store);
    return credential;
  });
  await assert.rejects(f.pipeline.run(f.grok.profile.id, 'drive', 'download-file', { fileId: logoId }), (error: unknown) => error instanceof ProviderError && error.status === 403);
  assert.equal(credentialMock.mock.callCount(), 1);
  assert.equal(calls.length, 0, 'revoked read scope must prevent any outgoing Drive request');
});

test('Drive reconsent upgrades the same account without replacing its profile key, refresh token, or other accounts', async t => {
  const f = createStore(t);
  const session = f.store.createSession();
  let subject = 'work';
  let scopes = [...baselineScopes];
  let issueRefreshToken = true;
  let accessToken = 'private-old-access-work';
  const googleMock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: accessToken, ...(issueRefreshToken ? { refresh_token: `private-refresh-${subject}` } : {}), expires_in: 3600, scope: ['openid', 'email', ...scopes].join(' ') });
    assert.equal(String(input), 'https://openidconnect.googleapis.com/v1/userinfo');
    return Response.json({ sub: subject, email: `${subject}@example.com`, email_verified: true, name: subject });
  });
  const finish = (url: URL) => f.accounts.finishOAuth(session, { state: url.searchParams.get('state'), code: 'authorized-code' });
  const first = await finish(new URL(f.accounts.startOAuth(session, ['drive']).url));
  assert.equal(first.driveDownloads, false, 'partial consent keeps the account connected but does not invent permission');
  const grok = f.accounts.createProfile({ name: 'Grok', bindings: [{ accountId: first.id, apps: ['drive'] }], defaultAccountId: first.id });
  const beforeProfile = f.accounts.resolveAgentKey(grok.apiKey);
  subject = 'personal';
  accessToken = 'private-personal-access';
  const second = await finish(new URL(f.accounts.startOAuth(session, ['drive']).url));
  const secondCredential = f.store.credential(`google-workspace:${second.id}`);
  await assert.rejects(f.pipeline.run(grok.profile.id, 'drive', 'download-file', { fileId: logoId }), /permission.*read existing files/i);
  const consent = new URL(f.accounts.startOAuth(session, ['drive'], first.id).url);
  const requested = consent.searchParams.get('scope')!.split(' ');
  for (const scope of [...baselineScopes, readScope]) assert.ok(requested.includes(scope));
  assert.equal(requested.includes('https://www.googleapis.com/auth/drive'), true, 'expanded Drive consent includes existing-file management');
  assert.equal(consent.searchParams.get('login_hint'), first.email);
  subject = 'work';
  accessToken = 'private-new-access-work';
  issueRefreshToken = false;
  scopes = [...baselineScopes, readScope];
  const updated = await finish(consent);
  assert.equal(updated.id, first.id);
  assert.equal(updated.driveDownloads, true);
  assert.deepEqual(updated.apps, ['drive']);
  assert.equal(f.accounts.listAccounts().length, 2);
  assert.deepEqual(f.accounts.resolveAgentKey(grok.apiKey), beforeProfile);
  assert.equal(f.store.credential(`google-workspace:${first.id}`)?.refreshToken, 'private-refresh-work');
  assert.deepEqual(f.store.credential(`google-workspace:${second.id}`), secondCredential);
  googleMock.mock.restore();
  const calls = mockDrive(t);
  assertDownload(await f.pipeline.run(grok.profile.id, 'drive', 'download-file', { fileId: logoId }));
  assert.deepEqual(calls.map(call => call.authorization), ['Bearer private-new-access-work', 'Bearer private-new-access-work']);
});
