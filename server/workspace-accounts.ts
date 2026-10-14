import type express from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from './config';
import { Store, hash } from './store';
import { fetchJson, isObject, safeCredential, tokenResponse } from './provider-http';
import { ProviderError, type Credential } from './provider-types';
import { workspaceApps } from './workspace-actions';

const ACCOUNTS = 'workspace.accounts.v1';
const PROFILES = 'workspace.profiles.v1';
const OAUTH_PROVIDER = 'google-workspace';
const MAX_ACCOUNTS = 25;
const MAX_PROFILES = 50;
const connectionId = (id: string) => `google-workspace:${id}`;
const callbackPath = '/api/workspace/google/callback';
const tokenUrl = 'https://oauth2.googleapis.com/token';

export interface WorkspaceAccount {
  id: string;
  email: string;
  name: string;
  apps: string[];
  requestedApps: string[];
  missingApps: string[];
  connectedAt: string;
  mapsConfigured: boolean;
  status: 'connected' | 'error';
}
interface StoredAccount {
  id: string;
  email: string;
  name: string;
  requestedApps: string[];
  scopes: string[];
  connectedAt: string;
}
export interface WorkspaceBinding { accountId: string; apps: string[]; accountEmail?: string }
export interface AgentProfile {
  id: string;
  name: string;
  bindings: WorkspaceBinding[];
  defaultAccountId?: string;
  createdAt: string;
  updatedAt: string;
}
interface StoredProfile extends AgentProfile { keyHash: string }
interface OAuthFlow { verifier: string; apps: string[]; accountId?: string; redirectUri: string; clientId: string; generation: number }

function inputString(value: unknown, label: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ProviderError(`${label} must be a valid, nonempty value.`);
  return value.trim();
}

function selectedApps(value: unknown, oauthOnly = false): string[] {
  if (!Array.isArray(value) || !value.length || value.length > workspaceApps.length || value.some(app => typeof app !== 'string')) throw new ProviderError('Choose at least one supported Workspace app.');
  const apps = [...new Set(value as string[])];
  for (const id of apps) {
    const app = workspaceApps.find(item => item.id === id);
    if (!app?.available || app.auth === 'unsupported' || (oauthOnly && app.auth !== 'oauth')) throw new ProviderError('Choose supported Google authorization apps. Maps uses a separate project API key.');
  }
  return apps;
}

function googleConfig(env: NodeJS.ProcessEnv) {
  const clientId = inputString(env.GOOGLE_CLIENT_ID, 'Google client ID', 8192);
  const clientSecret = inputString(env.GOOGLE_CLIENT_SECRET, 'Google client secret', 8192);
  return { clientId, clientSecret };
}

function grantedScopes(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new ProviderError('Google did not confirm the granted permissions. Connect again.', 502);
  return [...new Set(value.trim().split(/\s+/))];
}

/** The dashboard is the only authority that may create or change these profiles. */
export class WorkspaceAccounts {
  private refreshing = new Map<string, Promise<Credential>>();
  constructor(public readonly config: AppConfig, private readonly store: Store, private readonly env: NodeJS.ProcessEnv) {}

  private accounts(): StoredAccount[] { return this.store.readSetting<StoredAccount[]>(ACCOUNTS) || []; }
  private profiles(): StoredProfile[] { return this.store.readSetting<StoredProfile[]>(PROFILES) || []; }
  private account(id: string): StoredAccount {
    const account = this.accounts().find(item => item.id === id);
    if (!account || !this.store.credential(connectionId(id))) throw new ProviderError('This Google account is not connected.', 404);
    return account;
  }
  private publicAccount(account: StoredAccount): WorkspaceAccount {
    const credential = this.store.credential(connectionId(account.id));
    const apps = account.requestedApps.filter(id => {
      const app = workspaceApps.find(item => item.id === id);
      return app?.available && app.auth === 'oauth' && app.scopes.every(scope => account.scopes.includes(scope));
    });
    const mapsConfigured = !!credential?.fields?.mapsApiKey;
    if (mapsConfigured) apps.push('maps');
    return { id: account.id, email: account.email, name: account.name, apps, requestedApps: account.requestedApps,
      missingApps: account.requestedApps.filter(id => !apps.includes(id)), connectedAt: account.connectedAt, mapsConfigured,
      status: this.store.connection(connectionId(account.id))?.status || 'error' };
  }
  listAccounts(): WorkspaceAccount[] { return this.accounts().filter(item => !!this.store.connection(connectionId(item.id))).map(item => this.publicAccount(item)); }
  private publicProfile(profile: StoredProfile): AgentProfile {
    const { keyHash: _keyHash, ...publicProfile } = profile;
    const accounts = this.accounts();
    return { ...publicProfile, bindings: profile.bindings.map(binding => ({ ...binding, apps: [...binding.apps], accountEmail: accounts.find(account => account.id === binding.accountId)?.email || '' })) };
  }
  listProfiles(): AgentProfile[] { return this.profiles().map(profile => this.publicProfile(profile)); }
  getAgent(id: string): AgentProfile | null {
    const profile = this.profiles().find(item => item.id === id);
    return profile ? this.publicProfile(profile) : null;
  }
  snapshot() {
    const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter(name => !this.env[name]?.trim());
    return { apps: workspaceApps, accounts: this.listAccounts(), profiles: this.listProfiles(),
      google: { configured: !missing.length, missing, callbackUrl: `${this.config.origin}${callbackPath}` }, mcpUrl: `${this.config.origin}/mcp` };
  }

  startOAuth(session: string, appIds: unknown, expectedAccountId?: unknown): { url: string } {
    if (!this.store.validSession(session)) throw new ProviderError('Sign in before connecting Google.', 401);
    const { clientId } = googleConfig(this.env);
    let apps = selectedApps(appIds, true);
    let account: StoredAccount | undefined;
    if (expectedAccountId !== undefined) {
      account = this.account(inputString(expectedAccountId, 'Google account ID'));
      apps = [...new Set([...account.requestedApps, ...apps])];
    }
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const redirectUri = `${this.config.origin}${callbackPath}`;
    const scopes = [...new Set(['openid', 'email', ...apps.flatMap(id => workspaceApps.find(app => app.id === id)!.scopes)])];
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account',
      ...(account ? { login_hint: account.email } : {}) }).toString();
    const flow: OAuthFlow = { verifier, apps, redirectUri, clientId, generation: this.store.connectionGeneration(OAUTH_PROVIDER), ...(account ? { accountId: account.id } : {}) };
    this.store.saveOAuth(state, session, OAUTH_PROVIDER, JSON.stringify(flow));
    return { url: url.toString() };
  }

  async finishOAuth(session: string, input: { state: unknown; code?: unknown; error?: unknown }): Promise<WorkspaceAccount> {
    if (!this.store.validSession(session)) throw new ProviderError('Sign in before connecting Google.', 401);
    const state = inputString(input.state, 'Google authorization state', 128);
    const saved = this.store.takeOAuth(state, session, OAUTH_PROVIDER);
    if (!saved) throw new ProviderError('This Google authorization expired or belongs to another session. Connect again.');
    const flow = JSON.parse(saved.verifier) as OAuthFlow;
    this.store.assertConnectionGeneration(OAUTH_PROVIDER, flow.generation ?? 0);
    if (input.error) throw new ProviderError('Google authorization was declined. Your existing connections were kept.');
    const { clientId, clientSecret } = googleConfig(this.env);
    if (flow.clientId !== clientId || flow.redirectUri !== `${this.config.origin}${callbackPath}`) throw new ProviderError('Google settings changed during authorization. Connect again.');
    const body = await fetchJson('Google', tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, code: inputString(input.code, 'Google authorization code', 8192), code_verifier: flow.verifier,
      grant_type: 'authorization_code', redirect_uri: flow.redirectUri,
    }) });
    const credential = tokenResponse(body);
    safeCredential(credential);
    this.store.assertConnectionGeneration(OAUTH_PROVIDER, flow.generation ?? 0);
    const scopes = grantedScopes(body.scope);
    const identity = await fetchJson('Google', 'https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${credential.accessToken}` } });
    if (typeof identity.sub !== 'string' || !identity.sub || identity.sub.length > 255 || typeof identity.email !== 'string' || identity.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(identity.email) || identity.email_verified !== true) throw new ProviderError('Google did not return a verified account identity. Connect again.', 502);
    const id = createHmac('sha256', this.config.encryptionKey).update(`google-workspace:${identity.sub}`).digest('base64url');
    if (flow.accountId && flow.accountId !== id) throw new ProviderError('You selected a different Google account. Your existing connection was kept. Use Add Google account to connect another account.');
    const existingAccounts = this.accounts();
    const previousAccount = existingAccounts.find(account => account.id === id);
    if (!this.store.validSession(session)) throw new ProviderError('Your session ended during Google authorization. Sign in and connect again.', 401);
    if (flow.accountId && !previousAccount) throw new ProviderError('This Google account was disconnected during authorization. Use Add Google account to connect it again.', 409);
    this.store.assertConnectionGeneration(OAUTH_PROVIDER, flow.generation ?? 0);
    if (!previousAccount && existingAccounts.length >= MAX_ACCOUNTS) throw new ProviderError(`You can connect up to ${MAX_ACCOUNTS} Google accounts. Remove an unused account first.`);
    const previousCredential = this.store.credential(connectionId(id));
    const sameClient = previousCredential?.fields?.googleClientId === clientId;
    // Never reuse a refresh token from a different Google subject or OAuth client.
    if (!credential.refreshToken && sameClient && previousCredential?.refreshToken) credential.refreshToken = previousCredential.refreshToken;
    if (!credential.refreshToken) throw new ProviderError('Google did not grant offline access. Connect again and approve the requested permissions.');
    credential.fields = { googleClientId: clientId, ...(previousCredential?.fields?.mapsApiKey ? { mapsApiKey: previousCredential.fields.mapsApiKey } : {}) };
    const account: StoredAccount = { id, email: identity.email, name: typeof identity.name === 'string' ? identity.name.slice(0, 160) : identity.email,
      requestedApps: [...new Set([...(previousAccount?.requestedApps || []), ...flow.apps])], scopes, connectedAt: previousAccount?.connectedAt || new Date().toISOString() };
    this.store.save(connectionId(id), credential, { accountId: id, accountName: identity.email, resources: [] });
    this.store.writeSetting(ACCOUNTS, [...existingAccounts.filter(item => item.id !== id), account]);
    return this.publicAccount(account);
  }

  async getCredential(accountId: string, app?: string): Promise<Credential> {
    this.account(accountId);
    const credential = this.store.credential(connectionId(accountId))!;
    if (app === 'maps') {
      if (!credential.fields?.mapsApiKey) throw new ProviderError('Add a Google Maps project API key for this account first.', 409);
      // The Maps project key is independent of the account's OAuth token.
      return { accessToken: '', fields: { mapsApiKey: credential.fields.mapsApiKey } };
    }
    if (credential.fields?.googleClientId !== this.env.GOOGLE_CLIENT_ID?.trim()) throw new ProviderError('This account uses different Google app settings. Restore those settings or reconnect this Google account.', 409);
    if (!credential.expiresAt || credential.expiresAt > Date.now() + 60_000) return credential;
    const running = this.refreshing.get(accountId);
    if (running) return running;
    const pending = this.refresh(accountId, credential).finally(() => {
      if (this.refreshing.get(accountId) === pending) this.refreshing.delete(accountId);
    });
    this.refreshing.set(accountId, pending);
    return pending;
  }

  private async refresh(accountId: string, credential: Credential): Promise<Credential> {
    const generation = this.store.connectionGeneration(connectionId(accountId));
    try {
      if (!credential.refreshToken) throw new ProviderError('This Google account needs authorization again. Reconnect it in Workspace settings.', 409);
      const { clientId, clientSecret } = googleConfig(this.env);
      const body = await fetchJson('Google', tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: credential.refreshToken,
      }) });
      const updated = tokenResponse(body, credential);
      safeCredential(updated);
      const scopes = body.scope !== undefined ? grantedScopes(body.scope) : undefined;
      this.store.assertConnectionGeneration(connectionId(accountId), generation);
      const current = this.store.credential(connectionId(accountId));
      if (!current) throw new ProviderError('This Google account was disconnected.', 409);
      if (current.accessToken !== credential.accessToken || current.refreshToken !== credential.refreshToken) return current;
      // Retain changes to an independently saved Maps project key during refresh.
      updated.fields = current.fields;
      const account = this.account(accountId);
      this.store.save(connectionId(accountId), updated, { accountId, accountName: account.email, resources: [] });
      if (scopes) {
        this.store.writeSetting(ACCOUNTS, this.accounts().map(account => account.id === accountId ? { ...account, scopes } : account));
      }
      return updated;
    } catch (error) {
      const current = this.store.credential(connectionId(accountId));
      if (generation === this.store.connectionGeneration(connectionId(accountId)) && current?.accessToken === credential.accessToken && current.refreshToken === credential.refreshToken) this.store.markError(connectionId(accountId), 'Google authorization needs attention. Reconnect this account in Workspace settings.');
      throw error;
    }
  }

  saveMapsKey(accountId: string, value: unknown): WorkspaceAccount {
    const account = this.account(accountId);
    const apiKey = inputString(value, 'Maps project API key', 512);
    if (!/^[A-Za-z0-9_-]+$/.test(apiKey)) throw new ProviderError('Enter a valid Google Maps project API key.');
    const credential = this.store.credential(connectionId(accountId))!;
    this.store.updateCredential(connectionId(accountId), { ...credential, fields: { ...credential.fields, mapsApiKey: apiKey } });
    return this.publicAccount(account);
  }
  removeMapsKey(accountId: string): WorkspaceAccount {
    const account = this.account(accountId);
    const credential = this.store.credential(connectionId(accountId))!;
    const { mapsApiKey: _key, ...fields } = credential.fields || {};
    this.store.updateCredential(connectionId(accountId), { ...credential, fields });
    this.store.disconnect(`${connectionId(accountId)}:maps`);
    this.store.writeSetting(PROFILES, this.profiles().map(profile => {
      const bindings = profile.bindings.map(binding => binding.accountId === accountId ? { ...binding, apps: binding.apps.filter(app => app !== 'maps') } : binding).filter(binding => binding.apps.length);
      const { defaultAccountId, ...remaining } = profile;
      return { ...remaining, bindings, ...(defaultAccountId && bindings.some(binding => binding.accountId === defaultAccountId) ? { defaultAccountId } : {}), updatedAt: new Date().toISOString() };
    }));
    return this.publicAccount(account);
  }
  /** Keep asynchronous requests from crossing a reset, even after reconnection. */
  captureConnection(accountId: string, app: string): () => void {
    const provider = connectionId(accountId);
    const generation = this.store.connectionGeneration(provider);
    const mapsGeneration = this.store.connectionGeneration(`${provider}:maps`);
    return () => {
      this.store.assertConnectionGeneration(provider, generation);
      if (app === 'maps') this.store.assertConnectionGeneration(`${provider}:maps`, mapsGeneration);
    };
  }
  disconnect(accountId: string): void {
    this.account(accountId);
    // New-account authorization does not identify its account until Google
    // answers. Cancel all unfinished Google sign-ins so none can restore it.
    this.store.disconnect(OAUTH_PROVIDER);
    this.store.disconnect(connectionId(accountId));
    this.refreshing.delete(accountId);
    this.store.writeSetting(ACCOUNTS, this.accounts().filter(account => account.id !== accountId));
    this.store.writeSetting(PROFILES, this.profiles().map(profile => {
      const { defaultAccountId, ...remaining } = profile;
      return { ...remaining, bindings: profile.bindings.filter(binding => binding.accountId !== accountId), ...(defaultAccountId && defaultAccountId !== accountId ? { defaultAccountId } : {}), updatedAt: new Date().toISOString() };
    }));
  }
  resetAll(): void {
    this.store.disconnect(OAUTH_PROVIDER);
    for (const account of this.accounts()) this.store.disconnect(connectionId(account.id));
    this.refreshing.clear();
    this.store.deleteSetting(ACCOUNTS);
    this.store.writeSetting(PROFILES, this.profiles().map(profile => {
      const { defaultAccountId: _default, ...remaining } = profile;
      return { ...remaining, bindings: [], updatedAt: new Date().toISOString() };
    }));
  }

  private profileInput(input: unknown): Pick<AgentProfile, 'name' | 'bindings' | 'defaultAccountId'> {
    if (!isObject(input)) throw new ProviderError('Provide an AI agent name and account permissions.');
    const name = inputString(input.name, 'AI agent name', 100);
    if (!Array.isArray(input.bindings) || input.bindings.length > MAX_ACCOUNTS) throw new ProviderError('Choose the Google accounts and apps this agent may use.');
    const accounts = this.listAccounts();
    const seen = new Set<string>();
    const bindings: WorkspaceBinding[] = input.bindings.map(value => {
      if (!isObject(value)) throw new ProviderError('Each permission must specify a Google account and apps.');
      const accountId = inputString(value.accountId, 'Google account ID');
      const account = accounts.find(item => item.id === accountId);
      if (!account || seen.has(accountId)) throw new ProviderError('Choose each connected Google account once.');
      seen.add(accountId);
      const apps = selectedApps(value.apps);
      if (apps.some(app => !account.apps.includes(app))) throw new ProviderError('Authorize the selected apps on this Google account before giving the agent access.');
      return { accountId, apps };
    });
    const defaultAccountId = input.defaultAccountId == null || input.defaultAccountId === '' ? undefined : inputString(input.defaultAccountId, 'Default Google account');
    if (defaultAccountId && !seen.has(defaultAccountId)) throw new ProviderError('The default account must be one of this agent’s allowed accounts.');
    return { name, bindings, ...(defaultAccountId ? { defaultAccountId } : {}) };
  }
  createProfile(input: unknown): { profile: AgentProfile; apiKey: string } {
    const profiles = this.profiles();
    if (profiles.length >= MAX_PROFILES) throw new ProviderError(`You can create up to ${MAX_PROFILES} AI agent profiles.`);
    const values = this.profileInput(input);
    const apiKey = `wsa_${randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    const profile: StoredProfile = { ...values, id: randomBytes(16).toString('base64url'), keyHash: hash(apiKey), createdAt: now, updatedAt: now };
    this.store.writeSetting(PROFILES, [...profiles, profile]);
    return { profile: this.publicProfile(profile), apiKey };
  }
  updateProfile(id: string, input: unknown): AgentProfile {
    const profiles = this.profiles();
    const current = profiles.find(profile => profile.id === id);
    if (!current) throw new ProviderError('This AI agent profile does not exist.', 404);
    const { defaultAccountId: _default, ...base } = current;
    const profile = { ...base, ...this.profileInput(input), updatedAt: new Date().toISOString() };
    this.store.writeSetting(PROFILES, profiles.map(item => item.id === id ? profile : item));
    return this.publicProfile(profile);
  }
  deleteProfile(id: string): void {
    const profiles = this.profiles();
    if (!profiles.some(profile => profile.id === id)) throw new ProviderError('This AI agent profile does not exist.', 404);
    this.store.writeSetting(PROFILES, profiles.filter(profile => profile.id !== id));
  }
  rotateProfileKey(id: string): { profile: AgentProfile; apiKey: string } {
    const profiles = this.profiles();
    const current = profiles.find(profile => profile.id === id);
    if (!current) throw new ProviderError('This AI agent profile does not exist.', 404);
    const apiKey = `wsa_${randomBytes(32).toString('base64url')}`;
    const profile = { ...current, keyHash: hash(apiKey), updatedAt: new Date().toISOString() };
    this.store.writeSetting(PROFILES, profiles.map(item => item.id === id ? profile : item));
    return { profile: this.publicProfile(profile), apiKey };
  }
  resolveAgentKey(key: string): AgentProfile | null {
    if (!/^wsa_[A-Za-z0-9_-]{43}$/.test(key)) return null;
    const candidate = Buffer.from(hash(key), 'hex');
    const profile = this.profiles().find(item => timingSafeEqual(candidate, Buffer.from(item.keyHash, 'hex')));
    return profile ? this.publicProfile(profile) : null;
  }
  authorize(profileId: string, appId: string, requestedAccountId?: string): WorkspaceAccount {
    const profile = this.profiles().find(item => item.id === profileId);
    if (!profile) throw new ProviderError('This AI agent profile has been revoked.', 403);
    const accountId = requestedAccountId || profile.defaultAccountId;
    if (!accountId) throw new ProviderError('Specify the Google account ID, or set a default account for this AI agent.', 409);
    const binding = profile.bindings.find(item => item.accountId === accountId);
    if (!binding?.apps.includes(appId)) throw new ProviderError('This AI agent is not allowed to use that Google account and app.', 403);
    const account = this.publicAccount(this.account(accountId));
    if (!account.apps.includes(appId)) throw new ProviderError('This Google account has not granted access to that app. Reconnect it with the required permissions.', 403);
    return account;
  }
}

/** Mount after the normal dashboard session and request-origin middleware. */
export function mountWorkspace(app: express.Express, service: WorkspaceAccounts, sessionToken: (request: express.Request) => string, options: { localOrigin?: string } = {}) {
  app.use('/api/workspace', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many Workspace requests. Try again in a minute.' } }));
  app.get('/api/workspace', (_req, res) => res.json(service.snapshot()));
  app.post('/api/workspace/google/start', (req, res) => {
    if (options.localOrigin && options.localOrigin !== service.config.origin && req.headers.host === new URL(options.localOrigin).host) return void res.status(409).json({ error: 'Open the public dashboard and sign in before connecting Google so authorization returns to the same browser session.', publicOrigin: service.config.origin });
    res.json(service.startOAuth(sessionToken(req), req.body?.apps, req.body?.accountId));
  });
  app.get(callbackPath, async (req, res) => {
    try {
      await service.finishOAuth(sessionToken(req), { state: req.query.state, code: req.query.code, error: req.query.error });
      res.redirect('/?workspace=connected');
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : 'Google authorization could not be completed. Try again.';
      res.redirect(`/?error=${encodeURIComponent(message)}`);
    }
  });
  app.delete('/api/workspace/accounts/:id', (req, res) => { service.disconnect(String(req.params.id)); res.json({ ok: true }); });
  app.put('/api/workspace/accounts/:id/maps-key', (req, res) => res.json({ account: service.saveMapsKey(String(req.params.id), req.body?.apiKey) }));
  app.delete('/api/workspace/accounts/:id/maps-key', (req, res) => res.json({ account: service.removeMapsKey(String(req.params.id)) }));
  app.post('/api/workspace/profiles', (req, res) => res.json(service.createProfile(req.body)));
  app.put('/api/workspace/profiles/:id', (req, res) => res.json({ profile: service.updateProfile(String(req.params.id), req.body) }));
  app.delete('/api/workspace/profiles/:id', (req, res) => { service.deleteProfile(String(req.params.id)); res.json({ ok: true }); });
  app.post('/api/workspace/profiles/:id/rotate-key', (req, res) => res.json(service.rotateProfileKey(String(req.params.id))));
}
