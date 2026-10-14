import { createHmac, randomBytes } from 'node:crypto';
import type { Express, Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { Store } from './store';
import { ProviderError, type Credential, type ProviderAdapter, type VerifiedAccount } from './provider-types';
import { isObject } from './provider-http';
import { maskedAccount, plaidConfig, plaidCountryCodes, plaidLabel, plaidRecords, plaidRequest, plaidText } from './plaid-http';

const activeExchanges = new WeakSet<Store>();
export const isPlaidExchangeActive = (store: Store): boolean => activeExchanges.has(store);

export async function verifyPlaid(credential: Credential, env: NodeJS.ProcessEnv): Promise<VerifiedAccount> {
  const body = await plaidRequest('/accounts/get', {}, env, credential);
  const accounts = plaidRecords(body, 'accounts');
  if (!isObject(body.item) || typeof body.item.item_id !== 'string' || !body.item.item_id || accounts.some(account => typeof account.account_id !== 'string' || !account.account_id)) {
    throw new ProviderError('Plaid did not return a valid bank connection.', 502);
  }
  if (credential.fields?.plaidItemId !== body.item.item_id) throw new ProviderError('Plaid returned a different bank connection. Reconnect this institution.', 502);
  return {
    accountId: body.item.item_id,
    accountName: plaidLabel(env),
    resources: accounts.map(account => ({ id: String(account.account_id), name: [plaidText(account.name) || 'Bank account', maskedAccount(account.mask)].filter(Boolean).join(' · '), type: 'bank-account' })),
  };
}

/** Revoke at Plaid before deleting the local encrypted token, including its subscription. */
export async function removePlaidItem(credential: Credential, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await plaidRequest('/item/remove', {}, env, credential);
  if (typeof result.request_id !== 'string' || !result.request_id) throw new ProviderError('Plaid did not confirm disconnection. The local connection was retained so you can retry.', 502);
}

export const plaidAdapters: ProviderAdapter[] = [{
  definition: {
    id: 'plaid', name: 'Plaid', category: 'finance', authType: 'link',
    description: 'Connect a bank with Plaid Link to read accounts, balances, and transactions. Starts in Sandbox with test data; real banks require Production access.',
    docsUrl: 'https://plaid.com/docs/link/web/',
  },
  requiredEnv: ['PLAID_CLIENT_ID', 'PLAID_SECRET'], verify: verifyPlaid,
}];

function input(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\s\x00-\x1f]/.test(value)) throw new ProviderError(`A valid ${label} is required.`);
  return value;
}

/** Mount only after the dashboard's authenticated-session and same-origin mutation middleware. */
export function mountPlaid(app: Express, store: Store, env: NodeJS.ProcessEnv, getSessionToken: (request: Request) => string, getOrigin: () => string, ownerKey?: Buffer): void {
  app.use('/api/plaid', rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many bank connection requests. Try again in a minute.' } }));
  app.post('/api/plaid/link-token', async (request, response) => {
    const generation = store.connectionGeneration('plaid');
    if (store.credential('plaid')) throw new ProviderError('One institution can be connected at a time. Disconnect the current Plaid connection before choosing another.', 409);
    const session = getSessionToken(request);
    if (!store.validSession(session)) throw new ProviderError('Sign in before connecting your bank.', 401);
    const linkEnv = { ...env };
    const config = plaidConfig(linkEnv);
    const key = ownerKey || (env.ENCRYPTION_KEY && /^[a-fA-F0-9]{64}$/.test(env.ENCRYPTION_KEY) ? Buffer.from(env.ENCRYPTION_KEY, 'hex') : undefined);
    if (!key || key.length !== 32) throw new ProviderError('The workspace encryption key is required before connecting Plaid.', 503);
    const clientUserId = createHmac('sha256', key).update(`connector:plaid-owner:${config.clientId}`).digest('hex');
    const origin = new URL(getOrigin());
    if (config.environment === 'production' && origin.protocol !== 'https:') throw new ProviderError('Set an HTTPS address in workspace settings before connecting real banks.');
    const redirectUri = origin.protocol === 'https:' ? `${origin.origin}/plaid/callback` : undefined;
    const result = await plaidRequest('/link/token/create', {
      client_name: 'Connector', language: 'en', country_codes: plaidCountryCodes(linkEnv), products: ['transactions'],
      user: { client_user_id: clientUserId }, ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    }, linkEnv);
    store.assertConnectionGeneration('plaid', generation);
    if (typeof result.link_token !== 'string' || !result.link_token || result.link_token.length > 8192 || typeof result.expiration !== 'string' || !Number.isFinite(Date.parse(result.expiration)) || Date.parse(result.expiration) <= Date.now()) {
      throw new ProviderError('Plaid did not return a valid Link session. Try connecting again.', 502);
    }
    const flowId = randomBytes(32).toString('base64url');
    store.saveOAuth(flowId, session, 'plaid-link', JSON.stringify({ environment: config.environment, clientId: config.clientId }));
    response.json({ linkToken: result.link_token, flowId, expiresAt: new Date(Math.min(Date.parse(result.expiration), Date.now() + 10 * 60_000)).toISOString(), environment: config.environment, ...(redirectUri ? { redirectUri } : {}) });
  });
  app.post('/api/plaid/exchange', async (request, response) => {
    const generation = store.connectionGeneration('plaid');
    const session = getSessionToken(request);
    if (!store.validSession(session)) throw new ProviderError('Sign in before connecting your bank.', 401);
    const flowId = input(request.body?.flowId, 'bank connection flow', 128);
    const publicToken = input(request.body?.publicToken, 'Plaid public token', 8192);
    if (activeExchanges.has(store)) throw new ProviderError('A bank connection is already being saved. Wait for it to finish.', 409);
    if (store.credential('plaid')) throw new ProviderError('Disconnect your current Plaid institution before connecting another.', 409);
    const flow = store.takeOAuth(flowId, session, 'plaid-link');
    if (!flow) throw new ProviderError('This bank authorization expired or belongs to another session. Connect again.');
    const bound = JSON.parse(flow.verifier) as { environment: string; clientId: string };
    const exchangeEnv = { ...env };
    const config = plaidConfig(exchangeEnv);
    if (bound.environment !== config.environment || bound.clientId !== config.clientId) throw new ProviderError('Plaid settings changed during authorization. Start a new bank connection.');
    activeExchanges.add(store);
    try {
      const result = await plaidRequest('/item/public_token/exchange', { public_token: publicToken }, exchangeEnv);
      if (typeof result.access_token !== 'string' || !result.access_token || typeof result.item_id !== 'string' || !result.item_id) throw new ProviderError('Plaid did not return a valid bank connection. Start again.', 502);
      const credential: Credential = { accessToken: result.access_token, fields: { plaidEnvironment: config.environment, plaidClientId: config.clientId, plaidItemId: result.item_id } };
      try {
        store.assertConnectionGeneration('plaid', generation);
        const account = await verifyPlaid(credential, exchangeEnv);
        store.assertConnectionGeneration('plaid', generation);
        const current = plaidConfig(env);
        if (current.environment !== config.environment || current.clientId !== config.clientId || current.secret !== config.secret) throw new ProviderError('Plaid settings changed during authorization. Connect again.');
        response.json({ connection: store.save('plaid', credential, account) });
      } catch {
        // An exchange created a billable Item. Avoid silently losing its token on a later read failure.
        try { await removePlaidItem(credential, exchangeEnv); }
        catch {
          // A reset deliberately discards local credentials even if Plaid is
          // unreachable. Never restore a late Item after that decision.
          if (store.connectionGeneration('plaid') !== generation) throw new ProviderError('Plaid remains disabled locally, but the unfinished bank authorization created a connection that Plaid did not confirm revoking. Remove it in your Plaid dashboard or bank settings to stop remaining access or charges.', 409);
          store.save('plaid', credential, { accountName: plaidLabel(exchangeEnv), accountId: result.item_id, resources: [] });
          store.markError('plaid', 'Bank verification failed. The encrypted connection was retained so you can verify or disconnect it.');
          throw new ProviderError('Bank verification failed and Plaid did not confirm revocation. Open this connection to verify or disconnect it.', 502);
        }
        store.assertConnectionGeneration('plaid', generation);
        throw new ProviderError('Bank verification failed. The new Plaid connection was revoked; connect again.', 502);
      }
    } finally { activeExchanges.delete(store); }
  });
}
