import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from './config';
import { Store, hash } from './store';
import { ProviderError } from './provider-types';
import type { WorkspaceAccounts } from './workspace-accounts';

const SETTING = 'mcp.oauth.v1';
const ACCESS_MS = 60 * 60_000;
const REFRESH_MS = 30 * 24 * 60 * 60_000;
const PENDING_MS = 10 * 60_000;
const CODE_MS = 60_000;
const UNUSED_CLIENT_MS = 60 * 60_000;
const SCOPES = ['mcp:tools', 'offline_access'];
const random = () => randomBytes(32).toString('base64url');
const same = (left: string, right: string) => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
interface Client { id: string; name: string; redirects: string[]; method: AuthMethod; secretHash?: string; created: number; refresh: boolean; approvedAt?: number }
interface RequestBinding { clientId: string; redirectUri: string; challenge: string; state?: string; scope: string; issuer: string; resource: string }
interface Pending extends RequestBinding { id: string; expires: number; sessionHash?: string }
interface Code extends RequestBinding { hash: string; expires: number; grantId: string; used?: boolean }
interface Grant { id: string; clientId: string; clientName: string; redirectUri: string; issuer: string; resource: string; scope: string; platforms: boolean; workspaceProfileId?: string; created: number; expires: number; revoked?: boolean; lastUsed?: number }
interface Access { hash: string; grantId: string; expires: number }
interface Refresh { hash: string; grantId: string; expires: number; used?: boolean }
interface State { clients: Client[]; pending: Pending[]; codes: Code[]; grants: Grant[]; access: Access[]; refresh: Refresh[] }
export interface McpAuthorization { grantId: string; platforms: boolean; workspaceProfileId?: string }
class OAuthError extends Error {
  constructor(public readonly error: string, message: string, public readonly status = 400) { super(message); }
}
function value(input: unknown, name: string, max = 2048): string {
  if (typeof input !== 'string' || !input.length || input.length > max || /[\u0000-\u001f\u007f]/.test(input)) throw new OAuthError('invalid_request', `${name} must be a valid value.`);
  return input;
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OAuthError('invalid_request', 'Provide an OAuth request object.');
  return input as Record<string, unknown>;
}
function redirectUri(input: unknown): string {
  const raw = value(input, 'redirect_uri');
  let uri: URL;
  try { uri = new URL(raw); } catch { throw new OAuthError('invalid_redirect_uri', 'Use an absolute HTTPS redirect URI.'); }
  if (uri.username || uri.password || uri.hash || raw.includes('#') || raw.includes('*') || (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname)))) throw new OAuthError('invalid_redirect_uri', 'Use HTTPS for redirects, or HTTP on the local loopback interface. Fragments and wildcards are not allowed.');
  return raw;
}
function scope(input: unknown, fallback = 'mcp:tools offline_access'): string {
  const requested = input === undefined ? fallback.split(' ') : value(input, 'scope', 256).split(' ');
  if (requested.some(item => !SCOPES.includes(item)) || !requested.includes('mcp:tools')) throw new OAuthError('invalid_scope', 'Supported scopes are mcp:tools and offline_access.');
  return SCOPES.filter(item => requested.includes(item)).join(' ');
}
function callback(binding: RequestBinding, params: Record<string, string>): string {
  const url = new URL(binding.redirectUri);
  for (const name of ['code', 'error', 'error_description', 'state', 'iss']) url.searchParams.delete(name);
  for (const [name, item] of Object.entries(params)) url.searchParams.set(name, item);
  if (binding.state !== undefined) url.searchParams.set('state', binding.state);
  url.searchParams.set('iss', binding.issuer);
  return url.toString();
}

/** Small, local authorization server. Only the signed-in owner may approve access. */
export class McpOAuth {
  constructor(public readonly config: AppConfig, private readonly store: Store, private readonly workspace: WorkspaceAccounts) {}
  private state(): State {
    const saved = this.store.readSetting<State>(SETTING) || { clients: [], pending: [], codes: [], grants: [], access: [], refresh: [] };
    const countBefore = Object.values(saved).reduce((total, records) => total + records.length, 0);
    const now = Date.now();
    // Keep consumed refresh tokens until the grant expires so reuse revokes their family.
    saved.pending = saved.pending.filter(item => item.expires > now && item.issuer === this.config.origin && item.resource === this.resource());
    saved.codes = saved.codes.filter(item => item.expires > now);
    saved.grants = saved.grants.filter(item => item.expires > now && !item.revoked && item.issuer === this.config.origin && item.resource === this.resource() && (!item.workspaceProfileId || this.workspace.getAgent(item.workspaceProfileId)));
    const grants = new Set(saved.grants.map(item => item.id));
    saved.codes = saved.codes.filter(item => grants.has(item.grantId));
    saved.access = saved.access.filter(item => item.expires > now && grants.has(item.grantId));
    saved.refresh = saved.refresh.filter(item => item.expires > now && grants.has(item.grantId));
    const referenced = new Set([...saved.pending.map(item => item.clientId), ...saved.grants.map(item => item.clientId)]);
    // Public registration must not permanently consume disk or registration slots.
    // Retain once-approved client IDs after expiry/revocation: AI apps cache them
    // and need to authorize again without repeating dynamic registration.
    saved.clients = saved.clients.filter(item => item.approvedAt !== undefined || item.created + UNUSED_CLIENT_MS > now || referenced.has(item.id));
    // Persist cleanup even on authentication reads: changing an issuer or deleting a
    // Workspace profile must not allow invalidated tokens to reappear later.
    if (Object.values(saved).reduce((total, records) => total + records.length, 0) < countBefore) this.save(saved);
    return saved;
  }
  private save(state: State) { this.store.writeSetting(SETTING, state); }
  resource() { return `${this.config.origin}/mcp`; }
  metadataUrl() { return `${this.config.origin}/.well-known/oauth-protected-resource/mcp`; }
  resourceMetadata() { return { resource: this.resource(), authorization_servers: [this.config.origin], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'Connector tools' }; }
  serverMetadata() {
    const origin = this.config.origin;
    return { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: SCOPES, authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: false };
  }
  register(input: unknown) {
    const body = object(input);
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 10) throw new OAuthError('invalid_client_metadata', 'Register between one and ten redirect URIs.');
    const redirects = [...new Set(body.redirect_uris.map(redirectUri))];
    const method = (body.token_endpoint_auth_method ?? 'none') as AuthMethod;
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) throw new OAuthError('invalid_client_metadata', 'Unsupported token endpoint authentication method.');
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== 'code')) throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported.');
    const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code') || grantTypes.some(item => !['authorization_code', 'refresh_token'].includes(String(item)))) throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported.');
    if (body.scope !== undefined) scope(body.scope);
    const state = this.state();
    if (state.clients.length >= 250) {
      const referenced = new Set([...state.pending.map(item => item.clientId), ...state.grants.map(item => item.clientId)]);
      // Bound retained metadata without removing any client with current access or
      // an authorization in progress. Inactive approved IDs are evicted only when full.
      const oldestInactive = state.clients.filter(item => item.approvedAt !== undefined && !referenced.has(item.id)).sort((left, right) => left.approvedAt! - right.approvedAt!)[0];
      if (oldestInactive) state.clients = state.clients.filter(item => item.id !== oldestInactive.id);
      else throw new OAuthError('temporarily_unavailable', 'Client registration is temporarily full. Never-approved registrations expire within one hour. Existing approved AI connections can continue.', 503);
    }
    const clientSecret = method === 'none' ? undefined : random();
    const client: Client = { id: `mcp_${random()}`, name: body.client_name === undefined ? 'Unnamed AI client' : value(body.client_name, 'client_name', 100), redirects, method,
      ...(clientSecret ? { secretHash: hash(clientSecret) } : {}), created: Date.now(), refresh: grantTypes.includes('refresh_token') };
    state.clients.push(client); this.save(state);
    return { client_id: client.id, client_id_issued_at: Math.floor(client.created / 1000), ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}), client_name: client.name,
      redirect_uris: redirects, token_endpoint_auth_method: method, response_types: ['code'], grant_types: client.refresh ? ['authorization_code', 'refresh_token'] : ['authorization_code'], scope: scope(body.scope) };
  }
  start(input: unknown): string {
    const body = object(input);
    const state = this.state();
    const clientId = value(body.client_id, 'client_id', 256);
    const client = state.clients.find(item => item.id === clientId);
    if (!client) throw new OAuthError('invalid_client', 'Register this AI client before connecting.');
    const redirect = redirectUri(body.redirect_uri);
    if (!client.redirects.includes(redirect)) throw new OAuthError('invalid_redirect_uri', 'The redirect URI does not exactly match this client registration.');
    if (body.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'Only authorization code responses are supported.');
    if (body.code_challenge_method !== 'S256' || typeof body.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)) throw new OAuthError('invalid_request', 'A SHA-256 PKCE code challenge is required.');
    if (body.resource !== undefined && body.resource !== this.resource()) throw new OAuthError('invalid_target', 'This authorization is only for this Connector MCP endpoint.');
    if (body.response_mode !== undefined && body.response_mode !== 'query') throw new OAuthError('invalid_request', 'Only query authorization responses are supported.');
    if (state.pending.length >= 100) throw new OAuthError('temporarily_unavailable', 'Too many pending connection requests. Try again shortly.', 503);
    const pending: Pending = { id: random(), clientId, redirectUri: redirect, challenge: body.code_challenge, ...(body.state !== undefined ? { state: value(body.state, 'state', 2048) } : {}), scope: scope(body.scope),
      issuer: this.config.origin, resource: this.resource(), expires: Date.now() + PENDING_MS };
    state.pending.push(pending); this.save(state);
    return `${this.config.origin}/?authorize=${pending.id}`;
  }
  private pending(state: State, id: string, session: string): Pending {
    if (!this.store.validSession(session)) throw new ProviderError('Sign in to approve this AI connection.', 401);
    const pending = state.pending.find(item => item.id === id && item.issuer === this.config.origin && item.resource === this.resource());
    if (!pending) throw new ProviderError('This AI connection request expired or has already been handled. Start the connection again.', 404);
    if (pending.sessionHash && !same(pending.sessionHash, hash(session))) throw new ProviderError('This connection request belongs to another browser session. Start the connection again.', 403);
    return pending;
  }
  consent(id: string, session: string) {
    const state = this.state();
    const pending = this.pending(state, id, session);
    pending.sessionHash = hash(session); this.save(state);
    return { id: pending.id, clientName: state.clients.find(item => item.id === pending.clientId)!.name, redirectUri: pending.redirectUri, scope: pending.scope, resource: pending.resource, expiresAt: new Date(pending.expires).toISOString(),
      requestedAccess: { platforms: true, workspace: true }, workspaceProfiles: this.workspace.listProfiles() };
  }
  approve(id: string, session: string, input: unknown) {
    const state = this.state();
    const pending = this.pending(state, id, session);
    if (!pending.sessionHash) throw new ProviderError('Review this connection request before approving it.', 409);
    const body = object(input);
    if (typeof body.approve !== 'boolean') throw new ProviderError('Choose whether to approve this AI connection.');
    if (!body.approve) {
      state.pending = state.pending.filter(item => item.id !== id); this.save(state);
      return { redirectUrl: callback(pending, { error: 'access_denied', error_description: 'The Connector owner declined access.' }) };
    }
    if (body.platforms !== undefined && typeof body.platforms !== 'boolean') throw new ProviderError('Choose the access this AI connection may use.');
    const workspaceProfileId = body.workspaceProfileId === undefined || body.workspaceProfileId === '' ? undefined : value(body.workspaceProfileId, 'Workspace profile', 128);
    if (workspaceProfileId && !this.workspace.getAgent(workspaceProfileId)) throw new ProviderError('Choose an existing Google Workspace agent profile.');
    if (body.platforms !== true && !workspaceProfileId) throw new ProviderError('Select platform access, a Google Workspace profile, or both.');
    if (state.grants.filter(item => !item.revoked).length >= 200) throw new ProviderError('Remove an unused AI connection before adding another.', 409);
    const grant: Grant = { id: random(), clientId: pending.clientId, clientName: state.clients.find(item => item.id === pending.clientId)!.name, redirectUri: pending.redirectUri, issuer: pending.issuer, resource: pending.resource,
      scope: pending.scope, platforms: body.platforms === true, ...(workspaceProfileId ? { workspaceProfileId } : {}), created: Date.now(), expires: Date.now() + REFRESH_MS };
    const code = random();
    state.clients.find(item => item.id === pending.clientId)!.approvedAt = Date.now();
    state.grants.push(grant); state.codes.push({ ...pending, hash: hash(code), expires: Date.now() + CODE_MS, grantId: grant.id });
    state.pending = state.pending.filter(item => item.id !== id); this.save(state);
    return { redirectUrl: callback(pending, { code }) };
  }
  private client(state: State, body: Record<string, unknown>, authorization?: string): Client {
    let clientId = body.client_id;
    let secret = body.client_secret;
    let basic = false;
    if (authorization) {
      if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization)) throw new OAuthError('invalid_client', 'Use the registered client authentication method.', 401);
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const split = decoded.indexOf(':');
      if (split < 1 || body.client_secret !== undefined) throw new OAuthError('invalid_client', 'Use one client authentication method.', 401);
      try {
        const headerId = decodeURIComponent(decoded.slice(0, split));
        if (clientId !== undefined && clientId !== headerId) throw new Error('mismatch');
        clientId = headerId; secret = decodeURIComponent(decoded.slice(split + 1));
      } catch { throw new OAuthError('invalid_client', 'Invalid client authentication.', 401); }
      basic = true;
    }
    const client = typeof clientId === 'string' ? state.clients.find(item => item.id === clientId) : undefined;
    if (!client || (client.method === 'none' && (basic || secret !== undefined)) || (client.method === 'client_secret_basic' && !basic) || (client.method === 'client_secret_post' && basic) ||
      (client.method !== 'none' && (typeof secret !== 'string' || secret.length > 256 || !same(hash(secret), client.secretHash || '')))) throw new OAuthError('invalid_client', 'Invalid client authentication.', 401);
    return client;
  }
  private liveGrant(state: State, id: string): Grant | undefined {
    const grant = state.grants.find(item => item.id === id && !item.revoked && item.expires > Date.now() && item.issuer === this.config.origin && item.resource === this.resource());
    if (grant?.workspaceProfileId && !this.workspace.getAgent(grant.workspaceProfileId)) return undefined;
    return grant;
  }
  private issue(state: State, grant: Grant, refresh: boolean) {
    if (state.access.length >= 2000 || state.refresh.length >= 10_000) throw new OAuthError('temporarily_unavailable', 'The active token limit has been reached. Try again later.', 503);
    const accessToken = `mcp_at_${random()}`;
    state.access.push({ hash: hash(accessToken), grantId: grant.id, expires: Math.min(Date.now() + ACCESS_MS, grant.expires) });
    const refreshToken = refresh ? `mcp_rt_${random()}` : undefined;
    if (refreshToken) state.refresh.push({ hash: hash(refreshToken), grantId: grant.id, expires: grant.expires });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: Math.floor(Math.min(ACCESS_MS, grant.expires - Date.now()) / 1000), scope: grant.scope, ...(refreshToken ? { refresh_token: refreshToken } : {}) };
  }
  token(input: unknown, authorization?: string) {
    const body = object(input);
    const state = this.state();
    const client = this.client(state, body, authorization);
    // Legacy MCP clients may omit resource; every code and token is still bound to this one resource.
    if (body.resource !== undefined && body.resource !== this.resource()) throw new OAuthError('invalid_target', 'This token is only for this Connector MCP endpoint.');
    let grant: Grant | undefined;
    if (body.grant_type === 'authorization_code') {
      const code = state.codes.find(item => item.hash === hash(value(body.code, 'code', 256)));
      if (!code || code.clientId !== client.id || code.redirectUri !== body.redirect_uri || code.issuer !== this.config.origin || code.resource !== this.resource()) throw new OAuthError('invalid_grant', 'The authorization code is invalid or expired.');
      const verifier = typeof body.code_verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier) ? body.code_verifier : '';
      if (!verifier || !same(createHash('sha256').update(verifier).digest('base64url'), code.challenge)) throw new OAuthError('invalid_grant', 'The PKCE verifier is invalid.');
      if (code.used) { const old = state.grants.find(item => item.id === code.grantId); if (old) old.revoked = true; this.save(state); throw new OAuthError('invalid_grant', 'This authorization code has already been used.'); }
      grant = this.liveGrant(state, code.grantId);
      if (!grant) throw new OAuthError('invalid_grant', 'This AI connection has expired or been revoked.');
      code.used = true;
    } else if (body.grant_type === 'refresh_token') {
      if (!client.refresh) throw new OAuthError('unauthorized_client', 'This client is not registered for refresh tokens.');
      const token = state.refresh.find(item => item.hash === hash(value(body.refresh_token, 'refresh_token', 256)));
      const matchedGrant = token && state.grants.find(item => item.id === token.grantId);
      if (!token || !matchedGrant || matchedGrant.clientId !== client.id) throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired.');
      if (token.used) { matchedGrant.revoked = true; this.save(state); throw new OAuthError('invalid_grant', 'Refresh token reuse was detected. Connect this AI client again.'); }
      grant = this.liveGrant(state, token.grantId);
      if (!grant) throw new OAuthError('invalid_grant', 'This AI connection has expired or been revoked.');
      if (body.scope !== undefined && scope(body.scope) !== grant.scope) throw new OAuthError('invalid_scope', 'Refresh using the originally authorized scope.');
      token.used = true;
    } else throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    const response = this.issue(state, grant, client.refresh && grant.scope.split(' ').includes('offline_access'));
    this.save(state); return response;
  }
  authenticate(token: string): McpAuthorization | null {
    if (!/^mcp_at_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const state = this.state();
    const access = state.access.find(item => item.hash === hash(token));
    const grant = access && this.liveGrant(state, access.grantId);
    return grant ? { grantId: grant.id, platforms: grant.platforms, ...(grant.workspaceProfileId ? { workspaceProfileId: grant.workspaceProfileId } : {}) } : null;
  }
  assertCurrent(token: string): McpAuthorization {
    const current = this.authenticate(token);
    if (!current) throw new ProviderError('This AI connection expired or was revoked. Connect it again from your AI app.', 401);
    return current;
  }
  /** Record an actual successful tool call, never a connection probe or discovery. */
  recordUse(token: string): void {
    this.assertCurrent(token);
    const state = this.state();
    const access = state.access.find(item => item.hash === hash(token));
    const grant = access && this.liveGrant(state, access.grantId);
    if (!grant) throw new ProviderError('This AI connection expired or was revoked. Connect it again from your AI app.', 401);
    grant.lastUsed = Date.now(); this.save(state);
  }
  revoke(input: unknown, authorization?: string) {
    const body = object(input); const state = this.state(); const client = this.client(state, body, authorization);
    const tokenHash = hash(value(body.token, 'token', 256));
    const token = state.access.find(item => item.hash === tokenHash) || state.refresh.find(item => item.hash === tokenHash);
    const grant = token && state.grants.find(item => item.id === token.grantId && item.clientId === client.id);
    if (grant) { grant.revoked = true; this.save(state); }
  }
  connections() {
    const state = this.state();
    return { url: this.resource(), grants: state.grants.filter(item => !!this.liveGrant(state, item.id)).map(item => ({ id: item.id, clientName: item.clientName, redirectUri: item.redirectUri, createdAt: new Date(item.created).toISOString(), expiresAt: new Date(item.expires).toISOString(), ...(item.lastUsed !== undefined ? { lastUsedAt: new Date(item.lastUsed).toISOString() } : {}), platforms: item.platforms,
      ...(item.workspaceProfileId ? { workspaceProfileId: item.workspaceProfileId, workspaceProfileName: this.workspace.getAgent(item.workspaceProfileId)?.name } : {}) })) };
  }
  disconnect(id: string) {
    const state = this.state(); const grant = state.grants.find(item => item.id === id);
    if (!grant) throw new ProviderError('This AI connection does not exist.', 404);
    grant.revoked = true; this.save(state);
  }
}

function replyError(error: unknown, res: express.Response) {
  if (error instanceof OAuthError) return void res.status(error.status).json({ error: error.error, error_description: error.message });
  if (error instanceof ProviderError) return void res.status(error.status).json({ error: error.message });
  const status = typeof error === 'object' && error && 'status' in error && error.status === 413 ? 413 : 400;
  res.status(status).json({ error: 'invalid_request', error_description: status === 413 ? 'The OAuth request is too large.' : 'This OAuth request could not be completed.' });
}
/** Mount before dashboard session/CSRF middleware. These endpoints never grant owner access themselves. */
export function mountOAuthPublic(app: express.Express, oauth: McpOAuth) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); next(); });
  router.use(rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'temporarily_unavailable', error_description: 'Too many OAuth requests. Try again in a minute.' } }));
  router.use(express.json({ limit: '16kb' }), express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 30 }));
  router.post('/register', rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'temporarily_unavailable', error_description: 'Too many client registrations. Try again later.' } }), (req, res) => { res.status(201).json(oauth.register(req.body)); });
  router.get('/authorize', (req, res) => { res.redirect(oauth.start(req.query)); });
  router.post('/token', (req, res) => { res.json(oauth.token(req.body, req.headers.authorization)); });
  router.post('/revoke', (req, res) => { oauth.revoke(req.body, req.headers.authorization); res.status(200).end(); });
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => replyError(error, res));
  app.use('/oauth', router);
  const discovery = (_req: express.Request, res: express.Response, body: unknown) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Access-Control-Allow-Origin', '*'); res.json(body); };
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) app.get(path, (req, res) => discovery(req, res, oauth.resourceMetadata()));
  app.get('/.well-known/oauth-authorization-server', (req, res) => discovery(req, res, oauth.serverMetadata()));
}
/** Mount after the dashboard session and same-origin JSON request protection. */
export function mountOAuthOwner(app: express.Express, oauth: McpOAuth, sessionToken: (request: express.Request) => string) {
  app.get('/api/ai/connectors', (_req, res) => res.json(oauth.connections()));
  app.delete('/api/ai/connectors/:id', (req, res) => { oauth.disconnect(String(req.params.id)); res.json({ ok: true }); });
  app.get('/api/ai/authorize/:id', (req, res) => { res.json(oauth.consent(String(req.params.id), sessionToken(req))); });
  app.post('/api/ai/authorize/:id', (req, res) => { res.json(oauth.approve(String(req.params.id), sessionToken(req), req.body)); });
}
