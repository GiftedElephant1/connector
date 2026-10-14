import type { Express } from 'express';
import type { ProviderDefinition } from './provider-types';
import { ProviderError } from './provider-types';
import { clearProviderSettings, providerSettingKeys } from './settings';
import { isPlaidExchangeActive, removePlaidItem } from './providers-plaid';
import { Store } from './store';

export interface ConnectorResetPlan {
  provider: { id: string; name: string };
  affectedProviders: { id: string; name: string }[];
  clearsGoogleWorkspace: boolean;
  pendingJobs: number;
}

export function connectorResetPlan(store: Store, catalog: ProviderDefinition[], id: string): ConnectorResetPlan {
  const resetCatalog = [...catalog.map(({ id, name }) => ({ id, name })), { id: 'google-workspace', name: 'Google Workspace' }];
  const provider = resetCatalog.find(entry => entry.id === id);
  if (!provider) throw new ProviderError('Unknown connector.', 404);
  const ids = new Set([id]);
  const keys = new Set(providerSettingKeys(id));
  // Shared app credentials and optional settings form one reset group. Iterate
  // to include indirect sharing too, so no connected account keeps stale setup.
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of resetCatalog) {
      if (ids.has(candidate.id) || !providerSettingKeys(candidate.id).some(key => keys.has(key))) continue;
      ids.add(candidate.id);
      for (const key of providerSettingKeys(candidate.id)) keys.add(key);
      changed = true;
    }
  }
  const clearsGoogleWorkspace = keys.has('GOOGLE_CLIENT_ID') || keys.has('GOOGLE_CLIENT_SECRET');
  return {
    provider: { id: provider.id, name: provider.name },
    affectedProviders: resetCatalog.filter(entry => ids.has(entry.id)),
    clearsGoogleWorkspace,
    pendingJobs: store.pendingJobs([...ids], clearsGoogleWorkspace ? ['google-workspace:'] : []),
  };
}

/** Mounted after owner session, mutation/CSRF and connection rate-limit guards. */
export function mountConnectorReset(app: Express, store: Store, env: NodeJS.ProcessEnv, catalog: ProviderDefinition[], resetGoogleWorkspace: () => void): void {
  app.get('/api/connections/:provider/reset', (req, res) => res.json(connectorResetPlan(store, catalog, String(req.params.provider))));
  app.post('/api/connections/:provider/reset', async (req, res) => {
    if (req.body?.confirmed !== true) throw new ProviderError('Confirm the affected connectors before resetting their saved setup.', 409);
    const plan = connectorResetPlan(store, catalog, String(req.params.provider));
    const ids = plan.affectedProviders.map(provider => provider.id);
    const plaid = ids.includes('plaid') ? store.credential('plaid') : null;
    const plaidExchangeActive = ids.includes('plaid') && isPlaidExchangeActive(store);
    const priorEnv = { ...env };
    // Clear local access synchronously, before awaiting a remote revocation.
    for (const id of ids) store.disconnect(id);
    if (plan.clearsGoogleWorkspace) resetGoogleWorkspace();
    if (ids.includes('tiktok')) store.deleteSetting('tiktok-domain-verification-v1');
    clearProviderSettings(store, env, [...new Set(ids.flatMap(providerSettingKeys))]);
    const warnings: string[] = [];
    if (plaidExchangeActive) warnings.push('Plaid was disabled locally while a bank authorization was still finishing. Connector will attempt to revoke any resulting connection. Check your Plaid dashboard or bank settings for remaining access or charges before starting again.');
    if (plaid) {
      try { await removePlaidItem(plaid, priorEnv); }
      catch { warnings.push('Plaid was disabled locally, but Plaid could not confirm revocation. Remove the connection in your Plaid dashboard or bank settings to stop any remaining access or charges.'); }
    }
    res.json({ ok: true, affectedProviders: plan.affectedProviders, ...(warnings.length ? { warnings } : {}) });
  });
}
