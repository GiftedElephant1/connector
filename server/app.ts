import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from './config';
import { Store } from './store';
import * as providers from './providers';
import { Pipeline } from './pipeline';
import { mountPipeline } from './pipeline-http';
import { hydrateSettings, passwordMatches, providerSettings, savePassword, saveSettings, settingsSnapshot, updatePublicOrigin } from './settings';
import { mountTunnel, type PublicTunnel } from './tunnel';
import { mountPlaid, removePlaidItem } from './providers-plaid';
import { installation } from './installation';
import { WorkspaceAccounts, mountWorkspace } from './workspace-accounts';
import { McpOAuth, mountOAuthPublic, mountOAuthOwner } from './mcp-oauth';

export type ProviderService = Pick<typeof providers, 'providerCatalog' | 'getProvider' | 'getProviderSetup' | 'createOAuthRequest' | 'exchangeOAuthCode' | 'refreshCredential' | 'verifyConnection'>;

class RequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const sessionToken = (request: express.Request): string => {
  const value = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('connector_session='))?.slice('connector_session='.length) || '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
};
const digest = (value: string) => createHash('sha256').update(value).digest();
const stringValue = (value: unknown, name: string, max = 8192): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/.test(value)) throw new RequestError(`${name} is required and must be valid.`);
  return value.trim();
};
function safeError(error: unknown): { message: string; status: number } {
  if (error instanceof RequestError) return { message: error.message, status: error.status };
  if (error instanceof providers.ProviderError) {
    // An upstream 401 must not be confused with an expired local login session.
    return { message: error.message, status: error.status === 401 ? 422 : error.status };
  }
  return { message: 'The request could not be completed. Check the server configuration and try again.', status: 500 };
}

export interface AppOptions {
  desktopToken?: string;
  localOrigin?: string;
  tunnel?: PublicTunnel;
}

export function createApp(config: AppConfig, store: Store, service: ProviderService = providers, env: NodeJS.ProcessEnv = process.env, pipeline = new Pipeline(store, env), options: AppOptions = {}) {
  const isLoopbackHost = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  const initialOrigin = new URL(config.origin);
  const configuredLocalOrigin = options.localOrigin || (initialOrigin.protocol === 'http:' && isLoopbackHost(initialOrigin.hostname) ? config.origin : undefined);
  let localOrigin: string | undefined;
  if (configuredLocalOrigin) {
    const local = new URL(configuredLocalOrigin);
    if (local.protocol !== 'http:' || !isLoopbackHost(local.hostname) || local.username || local.password || local.pathname !== '/' || local.search || local.hash) throw new Error('The desktop address must be an HTTP loopback origin.');
    localOrigin = local.origin;
  }
  hydrateSettings(config, store, env);
  const hydratedOrigin = new URL(config.origin);
  if (options.localOrigin && localOrigin && hydratedOrigin.protocol === 'http:' && isLoopbackHost(hydratedOrigin.hostname) && config.origin !== localOrigin) updatePublicOrigin(config, store, env, localOrigin);
  let desktopToken = options.desktopToken && /^[A-Za-z0-9_-]{32,256}$/.test(options.desktopToken) ? options.desktopToken : undefined;
  const desktopInstance = desktopToken ? digest(desktopToken).toString('hex') : undefined;
  const desktopExpires = Date.now() + 10 * 60_000;
  const isLocalDashboard = (req: express.Request) => !!localOrigin && req.headers.host === new URL(localOrigin).host;
  const isSecureRequest = (req: express.Request) => config.secureCookies && !isLocalDashboard(req);
  const cookieOptions = (req: express.Request) => ({ httpOnly: true, secure: isSecureRequest(req), sameSite: 'lax' as const, path: '/', maxAge: 12 * 60 * 60 * 1000 });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://cdn.plaid.com'], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'https://*.plaid.com'], frameSrc: ['https://cdn.plaid.com'], formAction: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: isSecureRequest(req) ? [] : null },
    },
    strictTransportSecurity: isSecureRequest(req) ? undefined : false,
    referrerPolicy: { policy: 'no-referrer' },
  })(req, res, next));
  const workspaceAccounts = new WorkspaceAccounts(config, store, env);
  const mcpOAuth = new McpOAuth(config, store, workspaceAccounts);
  mountOAuthPublic(app, mcpOAuth);
  mountPipeline(app, config, store, pipeline, env, { accounts: workspaceAccounts, oauth: mcpOAuth });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '24kb' }));
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['x-connector-request'] !== '1' || (req.headers.origin && req.headers.origin !== config.origin && req.headers.origin !== localOrigin)) {
        return next(new RequestError('This request must come from the Connector app.', 403));
      }
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.setHeader('X-Connector-App', 'gifted-elephant-connector').json({ status: 'ok', ...(desktopInstance ? { desktopInstance } : {}) }));
  app.get('/api/session', (req, res) => res.json({ authenticated: store.validSession(sessionToken(req)) }));
  app.post('/api/desktop/unlock', rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }), (req, res) => {
    const supplied = typeof req.body?.token === 'string' ? req.body.token : '';
    const remote = req.socket.remoteAddress;
    if (!desktopToken || Date.now() > desktopExpires || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote || '') || !isLocalDashboard(req) || (req.headers.origin && req.headers.origin !== localOrigin) || !timingSafeEqual(digest(supplied), digest(desktopToken))) throw new RequestError('This desktop sign-in link is invalid or expired. Open Connector again from your PC.', 401);
    desktopToken = undefined;
    store.deleteSession(sessionToken(req));
    res.cookie('connector_session', store.createSession(), cookieOptions(req)).json({ ok: true });
  });
  app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' } }), (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length > 1024 || !passwordMatches(store, config, password)) throw new RequestError('The password is incorrect.', 401);
    store.deleteSession(sessionToken(req));
    const token = store.createSession();
    res.cookie('connector_session', token, cookieOptions(req)).json({ ok: true });
  });
  app.use('/api', (req, _res, next) => {
    if (!store.validSession(sessionToken(req))) return next(new RequestError('Sign in to continue.', 401));
    next();
  });
  app.get('/api/installation', (_req, res) => res.json(installation));
  mountOAuthOwner(app, mcpOAuth, sessionToken);
  mountWorkspace(app, workspaceAccounts, sessionToken, { localOrigin });
  app.get('/api/settings', (_req, res) => res.json(settingsSnapshot(config, store, env, localOrigin)));
  app.put('/api/settings', (req, res) => {
    saveSettings(config, store, env, req.body, localOrigin);
    res.json(settingsSnapshot(config, store, env, localOrigin));
  });
  app.get('/api/settings/providers/:provider', (req, res) => res.json(providerSettings(service.getProvider(String(req.params.provider)), config, env)));
  app.get('/api/settings/pipeline-key', (_req, res) => {
    if (!config.pipelineKey) throw new RequestError('The connector key has not been generated. Open the desktop launcher or run setup.', 409);
    res.json({ apiKey: config.pipelineKey, url: `${config.origin}/mcp`, transport: 'Streamable HTTP' });
  });
  app.post('/api/settings/password', (req, res) => {
    savePassword(store, req.body?.password);
    res.cookie('connector_session', store.createSession(), cookieOptions(req)).json({ ok: true });
  });
  if (options.tunnel) mountTunnel(app, options.tunnel);
  else app.get('/api/tunnel', (_req, res) => res.json({ status: 'stopped', available: false, configured: false }));
  app.use('/api/plaid', (req, res, next) => {
    if (isLocalDashboard(req) && localOrigin !== config.origin) return void res.status(409).json({ error: 'Open the public dashboard and sign in before connecting your bank so authorization returns to the same browser session.', publicOrigin: config.origin });
    next();
  });
  mountPlaid(app, store, env, sessionToken, () => config.origin, config.encryptionKey);
  app.post('/api/logout', (req, res) => {
    store.deleteSession(sessionToken(req));
    res.clearCookie('connector_session', cookieOptions(req)).json({ ok: true });
  });
  app.get('/api/providers', (_req, res) => {
    res.json({ providers: service.providerCatalog.map(provider => ({ ...provider, actions: pipeline.definitions(provider.id), ...service.getProviderSetup(provider.id, env), ...(provider.authType === 'oauth' ? { callbackUrl: `${config.origin}/api/oauth/${provider.id}/callback` } : {}), connection: store.connection(provider.id) })) });
  });
  const apiLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many connection requests. Try again in a minute.' } });
  app.use('/api/connections', apiLimit);
  app.use('/api/oauth', apiLimit);
  app.post('/api/connections/:provider/api-key', async (req, res) => {
    const id = String(req.params.provider);
    const provider = service.getProvider(id);
    if (provider.authType !== 'api_key' && provider.authType !== 'local') throw new RequestError('Use the official authorization flow for this platform.');
    const fields: Record<string, string> = {};
    for (const field of provider.credentialFields || []) fields[field.name] = stringValue(req.body?.fields?.[field.name], field.label);
    const credential: providers.Credential = { accessToken: provider.authType === 'local' ? 'local-vault' : stringValue(req.body?.apiKey, 'API key or access token'), ...(Object.keys(fields).length ? { fields } : {}) };
    const account = await service.verifyConnection(id, credential, env);
    const connection = store.save(id, credential, account);
    res.json({ connection });
  });
  app.post('/api/connections/:provider/verify', async (req, res) => {
    const id = String(req.params.provider);
    service.getProvider(id);
    let credential = store.credential(id);
    if (!credential) throw new RequestError('Connect this account first.', 404);
    try {
      if (credential.expiresAt && credential.expiresAt <= Date.now() + 60_000) {
        credential = await service.refreshCredential(id, credential, env);
        // Refresh tokens can rotate. Retain the new token even if the read check fails.
        store.updateCredential(id, credential);
      }
      const account = await service.verifyConnection(id, credential, env);
      res.json({ connection: store.save(id, credential, account) });
    } catch (error) {
      store.markError(id, safeError(error).message);
      throw error;
    }
  });
  app.delete('/api/connections/:provider', async (req, res) => {
    const id = String(req.params.provider);
    service.getProvider(id);
    const credential = store.credential(id);
    if (id === 'plaid' && credential) await removePlaidItem(credential, env);
    store.disconnect(id);
    res.json({ ok: true });
  });
  app.get('/api/jobs', (_req, res) => res.json({ jobs: pipeline.jobs() }));
  app.post('/api/jobs', (req, res) => res.json({ job: pipeline.schedule(req.body?.provider, req.body?.action, req.body?.values, req.body?.scheduledAt, req.body?.confirmed, req.body?.requestId) }));
  app.delete('/api/jobs/:id', (req, res) => res.json({ job: pipeline.cancel(String(req.params.id)) }));
  app.post('/api/actions/:provider/:action', async (req, res) => res.json(await pipeline.run(String(req.params.provider), String(req.params.action), req.body?.values, req.body?.confirmed, req.body?.requestId)));
  app.post('/api/oauth/:provider/start', (req, res) => {
    const id = String(req.params.provider);
    if (service.getProvider(id).authType !== 'oauth') throw new RequestError('This platform uses an API credential.');
    const setup = service.getProviderSetup(id, env);
    if (!setup.configured) throw new RequestError(`Configure these server settings first: ${setup.missing.join(', ')}.`);
    if (isLocalDashboard(req) && localOrigin !== config.origin) return void res.status(409).json({ error: 'Open the public dashboard and sign in before connecting this account so the platform can return to the same browser session.', publicOrigin: config.origin });
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const url = service.createOAuthRequest(id, { state, codeVerifier, redirectUri: `${config.origin}/api/oauth/${id}/callback`, env });
    store.saveOAuth(state, sessionToken(req), id, codeVerifier);
    res.json({ url });
  });
  app.get('/api/oauth/:provider/callback', async (req, res) => {
    const id = String(req.params.provider);
    try {
      service.getProvider(id);
      const state = stringValue(req.query.state, 'OAuth state', 128);
      const flow = store.takeOAuth(state, sessionToken(req), id);
      if (!flow) throw new RequestError('This authorization expired or does not belong to your session. Please connect again.');
      if (req.query.error) throw new RequestError('Authorization was declined or could not be completed. Please connect again.');
      const code = stringValue(req.query.code ?? req.query.auth_code, 'Authorization code');
      const credential = await service.exchangeOAuthCode(id, { code, codeVerifier: flow.verifier, redirectUri: `${config.origin}/api/oauth/${id}/callback`, env });
      const account = await service.verifyConnection(id, credential, env);
      store.save(id, credential, account);
      res.redirect(`/?connected=${encodeURIComponent(id)}`);
    } catch (error) {
      res.redirect(`/?error=${encodeURIComponent(safeError(error).message)}`);
    }
  });
  app.use('/api', (_req, _res, next) => next(new RequestError('This endpoint does not exist.', 404)));
  const dist = resolve('dist');
  app.use(express.static(dist, { index: false }));
  app.get('/{*path}', (_req, res) => {
    if (existsSync(resolve(dist, 'index.html'))) res.sendFile(resolve(dist, 'index.html'));
    else res.status(503).type('text').send('Build the interface with npm run build, then reload.');
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof SyntaxError) return void res.status(400).json({ error: 'The request body must be valid JSON.' });
    const result = safeError(error);
    res.status(result.status).json({ error: result.message });
  });
  return app;
}
