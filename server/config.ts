import { resolve } from 'node:path';

export interface AppConfig {
  origin: string;
  host: string;
  port: number;
  password: string;
  encryptionKey: Buffer;
  databasePath: string;
  secureCookies: boolean;
  pipelineKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:3000');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('APP_ORIGIN must be an origin without a path, query, or credentials.');
  }
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('APP_ORIGIN must use HTTP or HTTPS.');
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('Use HTTPS for a non-local APP_ORIGIN.');
  }
  if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 12) {
    throw new Error('Set APP_PASSWORD to at least 12 characters in .env. Run npm run setup first.');
  }
  if (!/^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY || '')) {
    throw new Error('ENCRYPTION_KEY must contain 64 hexadecimal characters. Run npm run setup first.');
  }
  const port = Number(env.PORT || 3000);
  if (env.PIPELINE_API_KEY && !/^[A-Za-z0-9_.~-]{32,256}$/.test(env.PIPELINE_API_KEY)) throw new Error('PIPELINE_API_KEY must contain 32–256 URL-safe characters. Run npm run setup.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return {
    origin: origin.origin,
    host: env.HOST || '127.0.0.1',
    port,
    password: env.APP_PASSWORD,
    encryptionKey: Buffer.from(env.ENCRYPTION_KEY!, 'hex'),
    databasePath: resolve(env.DATA_DIR || './data', 'connector.sqlite'),
    secureCookies: origin.protocol === 'https:',
    pipelineKey: env.PIPELINE_API_KEY || undefined,
  };
}
