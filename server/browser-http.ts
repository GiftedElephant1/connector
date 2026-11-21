import type express from 'express';
import { rateLimit } from 'express-rate-limit';
import { ProviderError } from './provider-types';
import type { Store } from './store';
import type { ManagedBrowserService } from './browser';

/** Mount after owner authentication and same-origin mutation protection. */
export function mountBrowserOwner(app: express.Express, service: ManagedBrowserService, store: Store, sessionToken: (req: express.Request) => string) {
  const current = (req: express.Request) => {
    const token = sessionToken(req);
    return () => { if (!store.validSession(token)) throw new ProviderError('Your Connector session ended. Sign in before changing browser access.', 401); };
  };
  app.use('/api/browser', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many browser setup requests. Wait a minute and try again.' } }));
  app.get('/api/browser', (_req, res) => res.json(service.snapshot()));
  app.put('/api/browser', async (req, res) => res.json(await service.configure(req.body, current(req))));
  app.post('/api/browser/check', async (req, res) => { const result = await service.check(); current(req)(); res.json(result); });
  app.post('/api/browser/close-all', async (req, res) => {
    if (!req.body || req.body.confirmed !== true || Object.keys(req.body).some(key => key !== 'confirmed')) throw new ProviderError('Confirm closing all browser sessions.', 409);
    const result = await service.closeAll(); current(req)(); res.json(result);
  });
}
