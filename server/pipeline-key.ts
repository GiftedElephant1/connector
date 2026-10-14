import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import type { AppConfig } from './config';
import type { Store } from './store';
import { ProviderError } from './provider-types';

const setting = 'pipeline-key-override';

/** An encrypted override prevents the old .env key returning after restart. */
export function hydratePipelineKey(config: AppConfig, store: Store, env: NodeJS.ProcessEnv): void {
  const saved = store.readSetting<string>(setting);
  if (saved === null) return;
  if (typeof saved !== 'string' || !/^[A-Za-z0-9_.~-]{32,256}$/.test(saved)) throw new Error('The saved Connector API key is invalid.');
  config.pipelineKey = saved;
  env.PIPELINE_API_KEY = saved;
}

/** Owner authentication and CSRF checks must run before these routes. */
export function mountPipelineKeyReset(app: Express, config: AppConfig, store: Store, env: NodeJS.ProcessEnv): void {
  app.post('/api/settings/pipeline-key/reset', (req, res) => {
    if (req.body?.confirmed !== true) throw new ProviderError('Confirm that every AI client using the shared Connector API key must reconnect.', 409);
    const apiKey = randomBytes(32).toString('base64url');
    store.writeSetting(setting, apiKey);
    hydratePipelineKey(config, store, env);
    res.json({ apiKey, url: `${config.origin}/mcp`, transport: 'Streamable HTTP' });
  });
}
