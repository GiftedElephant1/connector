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

export function createApp(config: AppConfig, store: Store, service: ProviderService = providers, env: NodeJS.ProcessEnv = process.env, pipeline = new Pipeline(store, env)) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: config.secureCookies ? [] : null },
    },
    strictTransportSecurity: config.secureCookies ? undefined : false,
    referrerPolicy: { policy: 'no-referrer' },
  }));
  mountPipeline(app, config, store, pipeline, env);
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '24kb' }));
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['x-connector-request'] !== '1' || (req.headers.origin && req.headers.origin !== config.origin)) {
        return next(new RequestError('This request must come from the Connector app.', 403));
      }
    }
    next();
  });
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const, path: '/', maxAge: 12 * 60 * 60 * 1000 };
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/session', (req, res) => res.json({ authenticated: store.validSession(sessionToken(req)) }));
  app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' } }), (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!timingSafeEqual(digest(password), digest(config.password))) throw new RequestError('The password is incorrect.', 401);
    store.deleteSession(sessionToken(req));
    const token = store.createSession();
    res.cookie('connector_session', token, cookieOptions).json({ ok: true });
  });
  app.use('/api', (req, _res, next) => {
    if (!store.validSession(sessionToken(req))) return next(new RequestError('Sign in to continue.', 401));
    next();
  });
  app.post('/api/logout', (req, res) => {
    store.deleteSession(sessionToken(req));
    res.clearCookie('connector_session', cookieOptions).json({ ok: true });
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
    if (provider.authType !== 'api_key') throw new RequestError('Use the official authorization flow for this platform.');
    const fields: Record<string, string> = {};
    for (const field of provider.credentialFields || []) fields[field.name] = stringValue(req.body?.fields?.[field.name], field.label);
    const credential: providers.Credential = { accessToken: stringValue(req.body?.apiKey, 'API key or access token'), ...(Object.keys(fields).length ? { fields } : {}) };
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
  app.delete('/api/connections/:provider', (req, res) => {
    const id = String(req.params.provider);
    service.getProvider(id);
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
