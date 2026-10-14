import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AppConfig } from '../server/config';
import { Store } from '../server/store';
import { WorkspaceAccounts } from '../server/workspace-accounts';
import { McpOAuth } from '../server/mcp-oauth';

const key = Buffer.alloc(32, 45);
const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
function fixture(t: TestContext, path = ':memory:') {
  const config: AppConfig = { origin: 'https://connector.example', host: '127.0.0.1', port: 3000, password: 'test-password-long', encryptionKey: key, databasePath: path, secureCookies: true };
  const store = new Store(path, key); t.after(() => store.close());
  const workspace = new WorkspaceAccounts(config, store, {});
  const oauth = new McpOAuth(config, store, workspace);
  const session = store.createSession();
  const client = oauth.register({ client_name: 'AI test client', redirect_uris: ['https://ai.example/callback'] });
  return { config, store, workspace, oauth, session, client };
}
type Fixture = ReturnType<typeof fixture>;
function pending(f: Fixture, input: Record<string, unknown> = {}) {
  const url = new URL(f.oauth.start({ client_id: f.client.client_id, redirect_uri: f.client.redirect_uris[0], response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: f.oauth.resource(), state: 'state-private-value', ...input }));
  return url.searchParams.get('authorize')!;
}
function code(f: Fixture, permissions: Record<string, unknown> = { platforms: true }, input: Record<string, unknown> = {}) {
  const id = pending(f, input); f.oauth.consent(id, f.session);
  const redirect = new URL(f.oauth.approve(id, f.session, { approve: true, ...permissions }).redirectUrl);
  return redirect.searchParams.get('code')!;
}
function exchange(f: Fixture, authCode = code(f), body: Record<string, unknown> = {}) {
  return f.oauth.token({ grant_type: 'authorization_code', client_id: f.client.client_id, redirect_uri: f.client.redirect_uris[0], code: authCode, code_verifier: verifier, resource: f.oauth.resource(), ...body });
}
const oauthError = (name: string) => (error: unknown) => !!error && typeof error === 'object' && 'error' in error && error.error === name;

test('MCP OAuth discovery advertises only implemented PKCE authorization and bound resource', t => {
  const f = fixture(t);
  assert.equal(f.oauth.resourceMetadata().resource, 'https://connector.example/mcp');
  assert.deepEqual(f.oauth.resourceMetadata().bearer_methods_supported, ['header']);
  assert.equal(f.oauth.serverMetadata().issuer, f.config.origin);
  assert.deepEqual(f.oauth.serverMetadata().code_challenge_methods_supported, ['S256']);
  assert.equal(f.oauth.serverMetadata().client_id_metadata_document_supported, false);
  assert.equal(f.oauth.metadataUrl(), 'https://connector.example/.well-known/oauth-protected-resource/mcp');
});

test('DCR rejects unsafe redirects, invalid metadata and unsupported grants without outbound requests', t => {
  const f = fixture(t);
  for (const uri of ['http://remote.example/callback', 'https://user:password@ai.example/cb', 'https://ai.example/cb#token', 'https://ai.example/cb#', 'https://*.example/cb', '/relative', 'javascript:alert(1)']) assert.throws(() => f.oauth.register({ redirect_uris: [uri] }), oauthError('invalid_redirect_uri'));
  for (const input of [{ redirect_uris: [] }, { redirect_uris: ['https://ai.example/cb'], token_endpoint_auth_method: 'private_key_jwt' }, { redirect_uris: ['https://ai.example/cb'], response_types: ['token'] }, { redirect_uris: ['https://ai.example/cb'], grant_types: ['client_credentials'] }]) assert.throws(() => f.oauth.register(input));
  for (const uri of ['http://127.0.0.1:4321/callback', 'http://[::1]:4321/callback', 'http://localhost:4321/callback']) assert.equal(f.oauth.register({ redirect_uris: [uri] }).redirect_uris[0], uri);
  assert.equal(f.client.client_secret, undefined);
});

test('authorization rejects unmatched redirect, duplicate fields, implicit tokens, missing PKCE, wrong scopes and target', t => {
  const f = fixture(t);
  for (const input of [{ redirect_uri: 'https://ai.example/callback/' }, { client_id: [f.client.client_id, 'other'] }, { response_type: 'token' }, { code_challenge_method: 'plain' }, { code_challenge: 'short' }, { resource: 'https://other.example/mcp' }, { resource: [f.oauth.resource()] }, { scope: 'admin' }, { response_mode: 'fragment' }]) assert.throws(() => pending(f, input));
  const id = pending(f, { state: 'client-state-✓' });
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.oauth.consent(id, f.session).redirectUri, f.client.redirect_uris[0]);
});

test('owner consent is explicit, session-bound, valid-session-only and single-use', t => {
  const f = fixture(t); const id = pending(f); const other = f.store.createSession();
  assert.throws(() => f.oauth.consent(id, 'invalid-session'), /Sign in/);
  assert.throws(() => f.oauth.approve(id, f.session, { approve: true, platforms: true }), /Review/);
  const view = f.oauth.consent(id, f.session);
  assert.equal(view.clientName, 'AI test client');
  assert.throws(() => f.oauth.consent(id, other), /another browser session/);
  assert.throws(() => f.oauth.approve(id, other, { approve: true, platforms: true }), /another browser session/);
  assert.throws(() => f.oauth.approve(id, f.session, { approve: true }), /Select platform access/);
  assert.throws(() => f.oauth.approve(id, f.session, { approve: 'yes', platforms: true }), /Choose whether/);
  assert.throws(() => f.oauth.approve(id, f.session, { approve: true, platforms: 'true' }), /Choose the access/);
  const redirect = new URL(f.oauth.approve(id, f.session, { approve: true, platforms: true }).redirectUrl);
  assert.equal(redirect.searchParams.get('state'), 'state-private-value');
  assert.equal(redirect.searchParams.get('iss'), f.config.origin);
  assert.throws(() => f.oauth.approve(id, f.session, { approve: true, platforms: true }), /already been handled/);
  const pendingAfterLogout = pending(f); f.oauth.consent(pendingAfterLogout, f.session); f.store.deleteSession(f.session);
  assert.throws(() => f.oauth.approve(pendingAfterLogout, f.session, { approve: true, platforms: true }), /Sign in/);
});

test('denial returns client state and no code without creating grants', t => {
  const f = fixture(t); const id = pending(f); f.oauth.consent(id, f.session);
  const url = new URL(f.oauth.approve(id, f.session, { approve: false }).redirectUrl);
  assert.equal(url.origin, 'https://ai.example');
  assert.equal(url.searchParams.get('error'), 'access_denied');
  assert.equal(url.searchParams.get('state'), 'state-private-value');
  assert.equal(url.searchParams.has('code'), false);
  assert.deepEqual(f.oauth.connections().grants, []);
  assert.throws(() => f.oauth.consent(id, f.session), /expired/);
});

test('code exchange binds client, redirect, resource and PKCE; successful replay revokes prior tokens', t => {
  const f = fixture(t); const authCode = code(f);
  const other = f.oauth.register({ redirect_uris: ['https://ai.example/callback'] });
  for (const body of [{ client_id: other.client_id }, { redirect_uri: 'https://ai.example/callback/' }, { resource: 'https://other.example/mcp' }, { code_verifier: 'w'.repeat(64) }, { code_verifier: ['v'.repeat(64)] }]) assert.throws(() => exchange(f, authCode, body));
  const token = exchange(f, authCode);
  assert.match(token.access_token, /^mcp_at_/);
  assert.equal(token.token_type, 'Bearer');
  assert.equal(f.oauth.authenticate(token.access_token)?.platforms, true);
  assert.throws(() => exchange(f, authCode, { code_verifier: 'incorrect'.repeat(8) }), oauthError('invalid_grant'));
  assert.ok(f.oauth.authenticate(token.access_token));
  assert.throws(() => exchange(f, authCode), oauthError('invalid_grant'));
  assert.equal(f.oauth.authenticate(token.access_token), null);
});

test('refresh tokens rotate and replay revokes the entire token family but not another connection', t => {
  const f = fixture(t); const first = exchange(f); const independent = exchange(f);
  const refreshed = f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: first.refresh_token });
  assert.notEqual(refreshed.access_token, first.access_token);
  assert.notEqual(refreshed.refresh_token, first.refresh_token);
  assert.ok(f.oauth.authenticate(refreshed.access_token));
  assert.throws(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: first.refresh_token }), oauthError('invalid_grant'));
  assert.equal(f.oauth.authenticate(first.access_token), null);
  assert.equal(f.oauth.authenticate(refreshed.access_token), null);
  assert.ok(f.oauth.authenticate(independent.access_token));
  assert.throws(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: refreshed.refresh_token }), oauthError('invalid_grant'));
});

test('refresh cannot change client, resource or scope and foreign revocations do not affect a grant', t => {
  const f = fixture(t); const first = exchange(f); const other = f.oauth.register({ redirect_uris: ['https://other.example/callback'] });
  for (const body of [{ client_id: other.client_id }, { resource: 'https://other.example/mcp' }, { scope: 'mcp:tools' }]) assert.throws(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: first.refresh_token, ...body }));
  f.oauth.revoke({ client_id: other.client_id, token: first.access_token });
  assert.ok(f.oauth.authenticate(first.access_token));
  f.oauth.revoke({ client_id: f.client.client_id, token: first.refresh_token });
  assert.equal(f.oauth.authenticate(first.access_token), null);
  f.oauth.revoke({ client_id: f.client.client_id, token: 'unknown-token' });
});

test('confidential clients require their registered authentication method and secret', t => {
  const f = fixture(t);
  for (const method of ['client_secret_post', 'client_secret_basic'] as const) {
    const client = f.oauth.register({ client_name: 'Confidential AI', redirect_uris: ['https://ai.example/callback'], token_endpoint_auth_method: method });
    assert.match(client.client_secret!, /^[A-Za-z0-9_-]{43}$/);
    const authCode = code(f, { platforms: true }, { client_id: client.client_id });
    const body = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code: authCode, code_verifier: verifier };
    assert.throws(() => f.oauth.token(body), oauthError('invalid_client'));
    assert.throws(() => f.oauth.token({ ...body, client_secret: 'wrong' }), oauthError('invalid_client'));
    const header = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`;
    assert.throws(() => f.oauth.token({ ...body, client_secret: client.client_secret }, header), oauthError('invalid_client'));
    const token = method === 'client_secret_post' ? f.oauth.token({ ...body, client_secret: client.client_secret }) : f.oauth.token(body, header);
    assert.ok(f.oauth.authenticate(token.access_token));
    assert.throws(() => f.oauth.token({ ...body, client_secret: client.client_secret }, `Bearer ${client.client_secret}`), oauthError('invalid_client'));
  }
  const authCode = code(f);
  assert.throws(() => exchange(f, authCode, { client_secret: 'not-allowed' }), oauthError('invalid_client'));
});

test('Workspace-only and combined grants stay bound to owner-selected live profiles', t => {
  const f = fixture(t);
  const first = f.workspace.createProfile({ name: 'Claude Google', bindings: [] }).profile;
  const other = f.workspace.createProfile({ name: 'ChatGPT Google', bindings: [] }).profile;
  const one = exchange(f, code(f, { workspaceProfileId: first.id }));
  const both = exchange(f, code(f, { platforms: true, workspaceProfileId: other.id }));
  assert.equal(f.oauth.authenticate(one.access_token)?.platforms, false);
  assert.equal(f.oauth.authenticate(one.access_token)?.workspaceProfileId, first.id);
  assert.equal(f.oauth.authenticate(both.access_token)?.platforms, true);
  assert.equal(f.oauth.authenticate(both.access_token)?.workspaceProfileId, other.id);
  const id = pending(f); f.oauth.consent(id, f.session);
  assert.throws(() => f.oauth.approve(id, f.session, { approve: true, workspaceProfileId: 'missing-profile' }), /existing Google Workspace/);
  f.workspace.deleteProfile(first.id);
  assert.equal(f.oauth.authenticate(one.access_token), null);
  assert.ok(f.oauth.authenticate(both.access_token));
  assert.throws(() => f.oauth.assertCurrent(one.access_token), /expired or was revoked/);
  assert.equal(f.oauth.connections().grants.length, 1);
});

test('owner revocation is immediate for access, refresh and pending authorized code', t => {
  const f = fixture(t); const authCode = code(f); const grant = f.oauth.connections().grants[0];
  f.oauth.disconnect(grant.id);
  assert.throws(() => exchange(f, authCode), oauthError('invalid_grant'));
  const token = exchange(f); const live = f.oauth.assertCurrent(token.access_token);
  f.oauth.disconnect(live.grantId);
  assert.equal(f.oauth.authenticate(token.access_token), null);
  assert.throws(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: token.refresh_token }), oauthError('invalid_grant'));
  assert.deepEqual(f.oauth.connections().grants, []);
});

test('owner reset clears a whole AI client including pending requests and every token family while preserving other clients', t => {
  const f = fixture(t);
  const profile = f.workspace.createProfile({ name: 'Shared Google profile', bindings: [] }).profile;
  f.store.save('linkedin', { accessToken: 'saved-platform-token' }, { accountName: 'Saved LinkedIn', resources: [] });
  const first = exchange(f, code(f, { platforms: true, workspaceProfileId: profile.id }));
  const second = exchange(f);
  const rotated = f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: first.refresh_token });
  const unexchangedCode = code(f);
  const request = pending(f);
  f.oauth.consent(request, f.session);
  const otherClient = f.oauth.register({ client_name: f.client.client_name, redirect_uris: f.client.redirect_uris });
  const otherFixture = { ...f, client: otherClient };
  const other = exchange(otherFixture);
  const otherPending = pending(otherFixture);
  const preview = f.oauth.resetPreview(f.client.client_id);
  assert.equal(preview.name, f.client.client_name);
  assert.equal(preview.grants, 3);
  assert.equal(preview.pendingRequests, 1);
  assert.equal(preview.accessTokens, 3);
  assert.equal(preview.refreshTokens, 3);
  assert.equal(preview.authorizationCodes, 3);
  assert.throws(() => f.oauth.resetClient(f.client.client_id, false), /Confirm/);
  assert.ok(f.oauth.authenticate(first.access_token));
  f.oauth.resetClient(f.client.client_id, true);
  for (const token of [first, second, rotated]) {
    assert.equal(f.oauth.authenticate(token.access_token), null);
    assert.throws(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: token.refresh_token }), oauthError('invalid_client'));
  }
  assert.throws(() => exchange(f, unexchangedCode), oauthError('invalid_client'));
  assert.throws(() => f.oauth.consent(request, f.session), /expired/);
  assert.throws(() => pending(f), oauthError('invalid_client'));
  assert.throws(() => f.oauth.resetPreview(f.client.client_id), /does not exist/);
  assert.ok(f.oauth.authenticate(other.access_token));
  assert.equal(f.oauth.consent(otherPending, f.session).clientName, otherClient.client_name);
  assert.equal(f.oauth.connections().grants.length, 1);
  assert.equal(f.oauth.connections().clients.length, 1);
  assert.equal(f.oauth.connections().clients[0].id, otherClient.client_id, 'names do not group separate registrations');
  assert.equal(f.store.credential('linkedin')?.accessToken, 'saved-platform-token');
  assert.ok(f.workspace.getAgent(profile.id));
  const saved = f.store.readSetting<Record<string, unknown[]>>('mcp.oauth.v1')!;
  assert.equal(JSON.stringify(saved).includes(f.client.client_id), false);
  const freshClient = f.oauth.register({ client_name: f.client.client_name, redirect_uris: f.client.redirect_uris });
  assert.ok(f.oauth.authenticate(exchange({ ...f, client: freshClient }).access_token));
});

test('owner can reset AI registrations that never finished approval', t => {
  const f = fixture(t);
  const request = pending(f);
  const clients = f.oauth.connections().clients;
  assert.equal(clients[0].grants, 0);
  assert.equal(clients[0].pendingRequests, 1);
  f.oauth.resetClient(f.client.client_id, true);
  assert.throws(() => f.oauth.consent(request, f.session), /expired/);
  assert.deepEqual(f.oauth.connections().clients, []);
  const client = f.oauth.register({ redirect_uris: ['https://unapproved.example/callback'] });
  assert.equal(f.oauth.resetPreview(client.client_id).pendingRequests, 0);
  f.oauth.resetClient(client.client_id, true);
  assert.deepEqual(f.oauth.connections().clients, []);
});

test('pending requests, authorization codes, access tokens and refresh grants expire', t => {
  const f = fixture(t); const start = Date.now(); let now = start;
  t.mock.method(Date, 'now', () => now);
  const id = pending(f); const expiredCode = code(f); const token = exchange(f);
  now = start + 60_001;
  assert.throws(() => exchange(f, expiredCode), oauthError('invalid_grant'));
  assert.ok(f.oauth.authenticate(token.access_token));
  now = start + 10 * 60_000 + 1;
  assert.throws(() => f.oauth.consent(id, f.session), /expired/);
  now = start + 60 * 60_000 + 1;
  assert.equal(f.oauth.authenticate(token.access_token), null);
  const refreshed = f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: token.refresh_token });
  assert.ok(f.oauth.authenticate(refreshed.access_token));
  now = start + 30 * 24 * 60 * 60_000 + 1;
  assert.equal(f.oauth.authenticate(refreshed.access_token), null);
  assert.throws(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: refreshed.refresh_token }), oauthError('invalid_grant'));
});

test('changing the public origin invalidates codes, pending consent, tokens and refresh', t => {
  const f = fixture(t); const id = pending(f); const authCode = code(f); const token = exchange(f);
  f.config.origin = 'https://new-connector.example';
  assert.equal(f.oauth.authenticate(token.access_token), null);
  assert.equal(f.oauth.connections().grants.length, 0);
  assert.throws(() => f.oauth.consent(id, f.session), /expired/);
  assert.throws(() => exchange(f, authCode), oauthError('invalid_grant'));
  assert.throws(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: token.refresh_token }), oauthError('invalid_grant'));
  f.config.origin = 'https://connector.example';
  assert.equal(f.oauth.authenticate(token.access_token), null);
  assert.throws(() => exchange(f, authCode), oauthError('invalid_grant'));
});

test('only token hashes and encrypted metadata persist, and tokens survive OAuth service recreation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'connector-mcp-oauth-'));
  const f = fixture(t, join(directory, 'data.sqlite')); const token = exchange(f);
  // Hooks run in registration order. Close SQLite before removing its files;
  // Windows cannot unlink an open database or its journal.
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const restarted = new McpOAuth(f.config, f.store, new WorkspaceAccounts(f.config, f.store, {}));
  assert.deepEqual(restarted.authenticate(token.access_token), f.oauth.authenticate(token.access_token));
  const saved = JSON.stringify(f.store.readSetting('mcp.oauth.v1'));
  assert.equal(saved.includes(token.access_token), false);
  assert.equal(saved.includes(token.refresh_token!), false);
  for (const file of readdirSync(directory)) {
    const raw = readFileSync(join(directory, file)).toString('utf8');
    for (const secret of [token.access_token, token.refresh_token!, 'AI test client', 'state-private-value', 'https://ai.example/callback']) assert.equal(raw.includes(secret), false, file);
  }
  assert.equal(f.oauth.authenticate('wsa_' + 'v'.repeat(43)), null);
  assert.equal(f.oauth.authenticate('mcp_at_' + 'v'.repeat(43)), null);
});

test('authorization without offline_access issues no refresh token', t => {
  const f = fixture(t);
  const token = exchange(f, code(f, { platforms: true }, { scope: 'mcp:tools' }));
  assert.equal(token.scope, 'mcp:tools');
  assert.equal(token.refresh_token, undefined);
  assert.ok(f.oauth.authenticate(token.access_token));
});

test('unused registrations expire and release capacity while pending and approved clients remain', t => {
  const f = fixture(t); let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const token = exchange(f);
  const disposable = f.oauth.register({ redirect_uris: ['https://unused.example/callback'] });
  for (let index = 0; index < 248; index++) f.oauth.register({ redirect_uris: [`https://unused.example/callback/${index}`] });
  assert.throws(() => f.oauth.register({ redirect_uris: ['https://unused.example/overflow'] }), oauthError('temporarily_unavailable'));
  now += 59 * 60_000;
  const id = pending(f, { client_id: disposable.client_id, redirect_uri: disposable.redirect_uris[0] });
  now += 2 * 60_000;
  const newClient = f.oauth.register({ redirect_uris: ['https://new.example/callback'] });
  assert.ok(newClient.client_id);
  assert.equal(f.oauth.consent(id, f.session).redirectUri, disposable.redirect_uris[0]);
  assert.doesNotThrow(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: token.refresh_token }));
  now += 10 * 60_000;
  f.oauth.register({ redirect_uris: ['https://new.example/another'] });
  assert.throws(() => pending(f, { client_id: disposable.client_id, redirect_uri: disposable.redirect_uris[0] }), oauthError('invalid_client'));
});


test('owner revocation immediately releases token capacity while active refresh replay evidence remains', t => {
  const f = fixture(t); const first = exchange(f); const authCode = code(f);
  const grantId = f.oauth.assertCurrent(first.access_token).grantId;
  type StoredState = { refresh: { hash: string; grantId: string; expires: number; used?: boolean }[] };
  const saved = f.store.readSetting<StoredState>('mcp.oauth.v1')!;
  for (let index = saved.refresh.length; index < 10_000; index++) saved.refresh.push({ hash: `capacity-test-${index}`, grantId, expires: Date.now() + 60 * 60_000, used: true });
  f.store.writeSetting('mcp.oauth.v1', saved);
  assert.throws(() => exchange(f, authCode), oauthError('temporarily_unavailable'));
  f.oauth.disconnect(grantId);
  const second = exchange(f, authCode);
  assert.ok(f.oauth.authenticate(second.access_token));
  assert.equal(f.oauth.authenticate(first.access_token), null);
  const rotated = f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: second.refresh_token });
  assert.ok(f.oauth.authenticate(rotated.access_token));
  assert.throws(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: second.refresh_token }), oauthError('invalid_grant'));
  assert.equal(f.oauth.authenticate(rotated.access_token), null);
});


test('successful tool use is recorded separately from authorization and cannot outlive revocation', t => {
  const f = fixture(t); const token = exchange(f); const grantId = f.oauth.assertCurrent(token.access_token).grantId;
  assert.equal(f.oauth.connections().grants[0].lastUsedAt, undefined);
  const now = Date.now() + 1000; t.mock.method(Date, 'now', () => now);
  f.oauth.recordUse(token.access_token);
  assert.equal(f.oauth.connections().grants[0].lastUsedAt, new Date(now).toISOString());
  f.oauth.disconnect(grantId);
  assert.throws(() => f.oauth.recordUse(token.access_token), /expired or was revoked/);
  assert.equal(f.oauth.connections().grants.length, 0);
});


test('deleting a Workspace profile releases its hidden grant token capacity', t => {
  const f = fixture(t);
  const profile = f.workspace.createProfile({ name: 'Workspace-only', bindings: [] }).profile;
  const first = exchange(f, code(f, { workspaceProfileId: profile.id }));
  const authCode = code(f); const grantId = f.oauth.assertCurrent(first.access_token).grantId;
  type StoredState = { access: { hash: string; grantId: string; expires: number }[] };
  const saved = f.store.readSetting<StoredState>('mcp.oauth.v1')!;
  for (let index = saved.access.length; index < 2000; index++) saved.access.push({ hash: `capacity-${index}`, grantId, expires: Date.now() + 60 * 60_000 });
  f.store.writeSetting('mcp.oauth.v1', saved);
  assert.throws(() => exchange(f, authCode), oauthError('temporarily_unavailable'));
  f.workspace.deleteProfile(profile.id);
  assert.equal(f.oauth.connections().grants.length, 1);
  assert.ok(f.oauth.authenticate(exchange(f, authCode).access_token));
  assert.equal(f.oauth.authenticate(first.access_token), null);
});


test('refresh accepts the authorized scope set regardless of scope order', t => {
  const f = fixture(t); const token = exchange(f);
  const refreshed = f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: token.refresh_token, scope: 'offline_access mcp:tools' });
  assert.equal(refreshed.scope, 'mcp:tools offline_access');
  assert.ok(f.oauth.authenticate(refreshed.access_token));
});


test('approved cached client IDs can authorize again after owner revocation and grant expiry', t => {
  const f = fixture(t); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const original = exchange(f); const grantId = f.oauth.assertCurrent(original.access_token).grantId;
  now += 2 * 60 * 60_000;
  f.oauth.disconnect(grantId);
  assert.equal(f.oauth.authenticate(original.access_token), null);
  const afterRevocation = exchange(f);
  assert.ok(f.oauth.authenticate(afterRevocation.access_token));
  now += 31 * 24 * 60 * 60_000;
  assert.equal(f.oauth.authenticate(afterRevocation.access_token), null);
  f.session = f.store.createSession();
  const afterExpiry = exchange(f);
  assert.ok(f.oauth.authenticate(afterExpiry.access_token));
});

test('registration pressure evicts only the oldest inactive approved client, preserving active and pending clients', t => {
  const f = fixture(t); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const originalClient = f.client;
  const active = exchange(f);
  f.client = f.oauth.register({ client_name: 'Old inactive', redirect_uris: ['https://old.example/callback'] });
  const retired = exchange(f); const retiredClient = f.client;
  f.oauth.disconnect(f.oauth.assertCurrent(retired.access_token).grantId);
  now += 1000;
  f.client = f.oauth.register({ client_name: 'Awaiting consent', redirect_uris: ['https://pending.example/callback'] });
  const awaiting = exchange(f); f.oauth.disconnect(f.oauth.assertCurrent(awaiting.access_token).grantId);
  const id = pending(f);
  for (let index = 0; index < 247; index++) f.oauth.register({ redirect_uris: [`https://filler.example/callback/${index}`] });
  assert.ok(f.oauth.register({ redirect_uris: ['https://new.example/callback'] }).client_id);
  assert.ok(f.oauth.authenticate(active.access_token));
  assert.equal(f.oauth.consent(id, f.session).clientName, 'Awaiting consent');
  assert.throws(() => pending(f, { client_id: retiredClient.client_id, redirect_uri: retiredClient.redirect_uris[0] }), oauthError('invalid_client'));
  f.client = originalClient;
  assert.doesNotThrow(() => pending(f));
  const saved = f.store.readSetting<{ clients: unknown[] }>('mcp.oauth.v1')!;
  assert.equal(saved.clients.length, 250);
});
