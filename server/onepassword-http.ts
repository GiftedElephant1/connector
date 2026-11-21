import type express from 'express';
import { rateLimit } from 'express-rate-limit';
import { ProviderError } from './provider-types';
import type { Store } from './store';
import type { OnePasswordService } from './onepassword';

/** Owner routes only: mount after session and same-origin mutation protection. */
export function mountOnePasswordOwner(app: express.Express, service: OnePasswordService, store: Store, sessionToken: (req: express.Request) => string) {
  const current = (req: express.Request) => {
    const token = sessionToken(req);
    return () => { if (!store.validSession(token)) throw new ProviderError('Your Connector session ended. Sign in before using 1Password.', 401); };
  };
  app.use('/api/onepassword', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many 1Password requests. Wait a minute and try again.' } }));
  app.get('/api/onepassword', (_req, res) => res.json(service.snapshot()));
  app.put('/api/onepassword', (req, res) => res.json(service.configure(req.body)));
  app.post('/api/onepassword/check', async (req, res) => { const result = await service.check(); current(req)(); res.json(result); });
  app.post('/api/onepassword/accounts', async (req, res) => res.json(await service.accounts(current(req))));
  app.post('/api/onepassword/vaults', async (req, res) => res.json(await service.vaults(req.body, current(req))));
  app.post('/api/onepassword/items', async (req, res) => res.json(await service.items(req.body, current(req))));
  app.post('/api/onepassword/fields', async (req, res) => res.json(await service.fields(req.body, current(req))));
  app.post('/api/onepassword/links', async (req, res) => res.json(await service.saveLink(req.body, current(req))));
  app.put('/api/onepassword/links/:id', async (req, res) => res.json(await service.saveLink(req.body, current(req), String(req.params.id))));
  app.delete('/api/onepassword/links/:id', (req, res) => res.json(service.remove(String(req.params.id))));
  app.post('/api/onepassword/links/:id/use', async (req, res) => {
    if (!req.body || req.body.confirmed !== true || Object.keys(req.body).some(key => key !== 'confirmed')) throw new ProviderError('Confirm use of this saved credential link.', 409);
    res.json(await service.use(String(req.params.id), 'owner', current(req)));
  });
}
