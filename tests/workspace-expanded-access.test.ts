import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { ActionAdapter, ActionResult } from '../server/action-types.ts';
import { validateValues } from '../server/actions.ts';
import type { AppConfig } from '../server/config.ts';
import { Pipeline } from '../server/pipeline.ts';
import { mountPipeline } from '../server/pipeline-http.ts';
import { ProviderError } from '../server/provider-types.ts';
import { Store } from '../server/store.ts';
import { WorkspaceAccounts } from '../server/workspace-accounts.ts';
import { getWorkspaceAction, workspaceApps } from '../server/workspace-actions.ts';
import { hasGoogleScope, hasGoogleScopes } from '../server/workspace-permissions.ts';
import { WorkspacePipeline } from '../server/workspace-pipeline.ts';

const realFetch = globalThis.fetch;
const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const env = { GOOGLE_CLIENT_ID: 'expanded-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'private-expanded-client-secret' };
const config: AppConfig = { origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, password: 'private-dashboard-password', encryptionKey: Buffer.alloc(32, 55), databasePath: ':memory:', secureCookies: false };
const initialApps = ['drive', 'gmail', 'chat', 'sheets'];
const baselineScopes = (apps = initialApps) => workspaceApps.filter(app => apps.includes(app.id)).flatMap(app => app.scopes);
const expandedScopes = (apps = initialApps) => [...new Set(workspaceApps.filter(app => apps.includes(app.id)).flatMap(app => [...app.scopes, ...app.additionalScopes || []]))];
type StoredAccount = { id: string; email: string; name: string; requestedApps: string[]; scopes: string[]; connectedAt: string };
type RunResult = { result: ActionResult; receipt?: { status: string } };

function fixture(t: TestContext, scopes = expandedScopes()) {
  const store = new Store(':memory:', config.encryptionKey);
  t.after(() => store.close());
  const accounts = new WorkspaceAccounts(config, store, env);
  for (const id of ['work', 'personal', 'hidden']) store.save(`google-workspace:${id}`, {
    accessToken: `private-access-${id}`, refreshToken: `private-refresh-${id}`, fields: { googleClientId: env.GOOGLE_CLIENT_ID },
  }, { accountId: id, accountName: `${id}@example.test`, resources: [] });
  store.writeSetting('workspace.accounts.v1', ['work', 'personal', 'hidden'].map(id => ({ id, email: `${id}@example.test`, name: id, requestedApps: initialApps, scopes, connectedAt: '2026-10-17T00:00:00.000Z' })));
  const grok = accounts.createProfile({ name: 'Grok', bindings: [{ accountId: 'work', apps: ['drive', 'sheets'] }], defaultAccountId: 'work' });
  const mail = accounts.createProfile({ name: 'Mail agent', bindings: [{ accountId: 'personal', apps: ['gmail'] }], defaultAccountId: 'personal' });
  return { store, accounts, grok, mail, pipeline: new WorkspacePipeline(store, accounts, env) };
}

function setScopes(store: Store, accountId: string, scopes: string[]) {
  store.writeSetting('workspace.accounts.v1', store.readSetting<StoredAccount[]>('workspace.accounts.v1')!.map(account => account.id === accountId ? { ...account, scopes } : account));
}

async function httpFixture(t: TestContext, scopes = expandedScopes()) {
  const f = fixture(t, scopes);
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
  let id = 0;
  const rpc = (key: string, name: string, args: unknown) => api(key, '/mcp', { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' });
  return { ...f, api, rpc };
}

test('Google scope implications accept broad grants without inventing broader or unrelated permissions', () => {
  for (const [granted, required] of [
    ['drive', 'drive.file'], ['drive', 'drive.readonly'], ['drive', 'drive.metadata.readonly'], ['drive.readonly', 'drive.metadata.readonly'],
    ['gmail.modify', 'gmail.readonly'], ['gmail.modify', 'gmail.compose'],
    ['chat.spaces', 'chat.spaces.readonly'], ['chat.messages', 'chat.messages.readonly'], ['chat.messages', 'chat.messages.create'],
  ]) assert.equal(hasGoogleScope([scope(granted)], scope(required)), true, `${granted} should satisfy ${required}`);
  assert.equal(hasGoogleScopes(['https://mail.google.com/'], [scope('gmail.readonly'), scope('gmail.compose')]), true);
  for (const [granted, required] of [
    [scope('drive.readonly'), scope('drive')], [scope('drive.file'), scope('drive.readonly')],
    ['https://mail.google.com/', scope('gmail.settings.basic')], [scope('chat.messages.readonly'), scope('chat.messages')],
    [scope('meetings.space.settings'), scope('meetings.space.created')], [scope('drive'), scope('gmail.readonly')],
  ]) assert.equal(hasGoogleScope([granted], required), false, `${granted} must not imply ${required}`);
});

test('broad-only Drive, mail and Chat grants retain legacy app access and full Drive downloads', t => {
  const f = fixture(t, [scope('drive'), 'https://mail.google.com/', scope('chat.spaces'), scope('chat.messages'), scope('spreadsheets')]);
  const work = f.accounts.listAccounts().find(account => account.id === 'work')!;
  assert.deepEqual(work.apps, initialApps);
  assert.deepEqual(work.missingApps, []);
  assert.equal(work.driveDownloads, true);
  assert.doesNotThrow(() => f.accounts.assertActionScopes('work', 'drive', [scope('drive.readonly')]));
  const download = f.pipeline.definitions(f.grok.profile.id, 'drive').find(action => action.id === 'download-file')!;
  assert.equal(download.available, true);
  assert.deepEqual(download.missingScopes, []);
});

test('partial consent keeps basic actions available and exposes only profile-permitted missing expanded permissions', t => {
  const f = fixture(t, baselineScopes());
  const work = f.accounts.listAccounts().find(account => account.id === 'work')!;
  assert.deepEqual(work.apps, initialApps);
  assert.ok(work.missingPermissions.find(item => item.app === 'drive')?.scopes.includes(scope('drive')));
  assert.ok(work.missingPermissions.find(item => item.app === 'gmail')?.scopes.includes('https://mail.google.com/'));
  assert.ok(work.missingPermissions.find(item => item.app === 'chat'));
  const discovered = f.pipeline.accounts(f.grok.profile.id);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].id, 'work');
  assert.deepEqual(discovered[0].missingPermissions.map(item => item.app), ['drive']);
  assert.equal(JSON.stringify(discovered).includes('private-'), false);
  const actions = f.pipeline.definitions(f.grok.profile.id, 'drive');
  assert.equal(actions.find(action => action.id === 'list-files')?.available, true);
  assert.equal(actions.find(action => action.id === 'upload-file')?.available, true, 'new uploads retain existing drive.file access');
  const advanced = actions.find(action => action.id === 'write-api')!;
  assert.equal(advanced.available, false);
  assert.deepEqual(advanced.requiredScopes, [scope('drive')]);
  assert.deepEqual(advanced.missingScopes, [scope('drive')]);
  setScopes(f.store, 'work', expandedScopes());
  assert.deepEqual(f.accounts.listAccounts().find(account => account.id === 'work')!.missingPermissions, []);
  assert.equal(f.pipeline.definitions(f.grok.profile.id, 'drive').find(action => action.id === 'write-api')?.available, true);
  assert.ok(f.accounts.listAccounts().find(account => account.id === 'personal')!.missingPermissions.length > 0, 'one account upgrade cannot upgrade another');
});

test('reauthorization records actual expanded consent while preserving the profile, other account and refresh credential', async t => {
  const f = fixture(t, baselineScopes());
  const session = f.store.createSession();
  // Use the identity generated by real account authorization rather than the fixture IDs.
  let granted = baselineScopes(['drive', 'gmail']);
  let freshRefresh = true;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    calls.push(String(input));
    if (String(input) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'private-current-account', ...(freshRefresh ? { refresh_token: 'private-renewable-account' } : {}), expires_in: 3600, scope: ['openid', 'email', ...granted].join(' ') });
    assert.equal(String(input), 'https://openidconnect.googleapis.com/v1/userinfo');
    return Response.json({ sub: 'expanded-person', email: 'expanded@example.test', email_verified: true });
  });
  let start = new URL(f.accounts.startOAuth(session, ['drive', 'gmail']).url);
  const first = await f.accounts.finishOAuth(session, { state: start.searchParams.get('state'), code: 'first-code' });
  const agent = f.accounts.createProfile({ name: 'Expanded agent', bindings: [{ accountId: first.id, apps: ['drive', 'gmail'] }], defaultAccountId: first.id });
  const other = f.store.credential('google-workspace:personal');
  const profile = f.accounts.resolveAgentKey(agent.apiKey);
  assert.ok(first.missingPermissions.length > 0);
  start = new URL(f.accounts.startOAuth(session, ['drive'], first.id).url);
  assert.equal(start.searchParams.get('login_hint'), 'expanded@example.test');
  for (const required of [scope('drive'), 'https://mail.google.com/', scope('gmail.settings.basic')]) assert.ok(start.searchParams.get('scope')!.split(' ').includes(required));
  assert.equal(start.searchParams.get('scope')!.includes(scope('chat.messages')), false, 'unselected apps must not be added to consent');
  granted = [scope('drive'), scope('drive.appdata'), scope('drive.apps.readonly'), 'https://mail.google.com/', scope('gmail.settings.basic')];
  freshRefresh = false;
  const upgraded = await f.accounts.finishOAuth(session, { state: start.searchParams.get('state'), code: 'upgrade-code' });
  assert.equal(upgraded.id, first.id);
  assert.deepEqual(upgraded.apps, ['drive', 'gmail']);
  assert.deepEqual(upgraded.missingPermissions, []);
  assert.deepEqual(f.accounts.resolveAgentKey(agent.apiKey), profile);
  assert.equal(f.store.credential(`google-workspace:${first.id}`)?.refreshToken, 'private-renewable-account');
  assert.deepEqual(f.store.credential('google-workspace:personal'), other);
  assert.equal(calls.length, 4);
});

test('expanded grants do not authorize another account or apps absent from the AI profile', async t => {
  const f = await httpFixture(t);
  let outgoing = 0;
  t.mock.method(globalThis, 'fetch', async () => { outgoing++; throw new Error('No Google request should be sent'); });
  for (const [key, app, accountId] of [[f.grok.apiKey, 'gmail', 'work'], [f.grok.apiKey, 'chat', 'work'], [f.grok.apiKey, 'drive', 'hidden'], [f.mail.apiKey, 'drive', 'personal']]) {
    const response = await f.api(key, `/api/v1/workspace/actions/${app}/read-api`, { accountId, values: { path: '/files' } });
    assert.equal(response.status, 403);
  }
  const mcp = await (await f.rpc(f.grok.apiKey, 'run_workspace_action', { app: 'drive', action: 'read-api', accountId: 'hidden', values: { path: '/files' } })).json() as { result: { isError: boolean } };
  assert.equal(mcp.result.isError, true);
  assert.equal(outgoing, 0);
});

test('expanded API writes require confirmation, replay once across REST and MCP, and recheck scopes before cached results', async t => {
  const f = await httpFixture(t);
  const calls: { url: string; token: string | null; body: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), token: new Headers(init?.headers).get('authorization'), body: String(init?.body) });
    assert.equal(init?.method, 'PATCH');
    assert.equal(init?.redirect, 'error');
    return Response.json({ id: 'existing_workbook', name: 'Financial model.xlsx' });
  });
  const values = { method: 'PATCH', path: '/files/existing_workbook', bodyJson: JSON.stringify({ name: 'Financial model.xlsx' }) };
  const args = { app: 'drive', action: 'write-api', values, requestId: 'expanded-rename-one' };
  assert.equal((await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/write-api', args)).status, 409);
  const noConsent = await (await f.rpc(f.grok.apiKey, 'run_workspace_action', args)).json() as { result: { isError: boolean } };
  assert.equal(noConsent.result.isError, true);
  assert.equal(calls.length, 0);
  const first = await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/write-api', { ...args, confirmed: true });
  assert.equal(first.status, 200);
  const initial = await first.json() as RunResult;
  assert.equal(initial.receipt?.status, 'succeeded');
  const repeated = await (await f.rpc(f.grok.apiKey, 'run_workspace_action', { ...args, confirmed: true })).json() as { result: { structuredContent: RunResult } };
  assert.deepEqual(repeated.result.structuredContent, initial);
  assert.deepEqual(calls, [{ url: 'https://www.googleapis.com/drive/v3/files/existing_workbook', token: 'Bearer private-access-work', body: '{"name":"Financial model.xlsx"}' }]);
  const altered = await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/write-api', { ...args, confirmed: true, values: { ...values, bodyJson: '{"name":"Different.xlsx"}' } });
  assert.equal(altered.status, 409);
  setScopes(f.store, 'work', baselineScopes());
  const revoked = await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/write-api', { ...args, confirmed: true });
  assert.equal(revoked.status, 403);
  assert.match(await revoked.text(), /Change connected apps/);
  assert.equal(calls.length, 1);
});

test('a refreshed token that loses full Drive scope cannot dispatch an expanded write', async t => {
  const f = fixture(t);
  const credential = f.store.credential('google-workspace:work')!;
  f.store.updateCredential('google-workspace:work', { ...credential, expiresAt: 1 });
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    urls.push(String(input));
    assert.equal(String(input), 'https://oauth2.googleapis.com/token');
    return Response.json({ access_token: 'private-narrowed-work', expires_in: 3600, scope: baselineScopes().join(' ') });
  });
  await assert.rejects(f.pipeline.run(f.grok.profile.id, 'drive', 'write-api', { method: 'DELETE', path: '/files/important_file' }, true, 'full-scope-was-revoked'), (error: unknown) => error instanceof ProviderError && error.status === 403);
  assert.deepEqual(urls, ['https://oauth2.googleapis.com/token']);
  assert.equal(f.pipeline.definitions(f.grok.profile.id, 'drive').find(action => action.id === 'write-api')?.available, false);
});

test('Excel bytes above the old text limit pass REST upload validation without relaxing social media file validation', async t => {
  const f = await httpFixture(t, baselineScopes());
  const bytes = Buffer.from(Array.from({ length: 96 * 1024 }, (_, index) => index % 251));
  const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let outgoing = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    outgoing++;
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/upload/drive/v3/files');
    assert.equal(url.searchParams.get('uploadType'), 'multipart');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-access-work');
    const body = Buffer.from(init?.body as Uint8Array);
    assert.notEqual(body.indexOf(bytes), -1, 'multipart upload must retain every original binary byte');
    assert.ok(body.includes(Buffer.from(mimeType)));
    return Response.json({ id: 'uploaded_workbook', name: 'Financial model.xlsx', mimeType, size: String(bytes.length), sha256Checksum: sha256 });
  });
  const values = { name: 'Financial model.xlsx', mimeType, contentBase64: bytes.toString('base64') };
  const request = { values, confirmed: true, requestId: 'upload-existing-drive-file-grant' };
  const response = await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/upload-file', request);
  assert.equal(response.status, 200);
  const result = await response.json() as RunResult;
  assert.equal(result.result.items?.[0].uploadedBytes, bytes.length);
  assert.equal(result.result.items?.[0].uploadedSha256, sha256);
  assert.equal(result.result.items?.[0].checksumVerified, true);
  assert.equal((await f.api(f.grok.apiKey, '/api/v1/workspace/actions/drive/upload-file', request)).status, 200);
  assert.equal(outgoing, 1, 'idempotent replay must not duplicate the uploaded file');
  const upload = getWorkspaceAction('drive', 'upload-file')!;
  assert.throws(() => validateValues(upload, { ...values, contentBase64: 'A'.repeat(28_000_001) }), /too large/i);
  const imageOnly: ActionAdapter = { provider: 'example-social', definition: { id: 'upload-image', label: 'Upload', kind: 'write', group: 'publishing', description: 'Existing image upload', fields: [{ name: 'file', label: 'Image', type: 'file', required: true }] }, execute: async () => ({ summary: 'unused' }) };
  assert.throws(() => validateValues(imageOnly, { file: `data:${mimeType};base64,UEsDBA==` }), /video or image/i);
  assert.doesNotThrow(() => validateValues(imageOnly, { file: 'data:image/png;base64,iVBORw==' }));
});
