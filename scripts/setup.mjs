import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'dotenv';

const path = new URL('../.env', import.meta.url);
const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
const values = parse(existing);
const defaults = {
  APP_ORIGIN: 'http://localhost:3000',
  HOST: '127.0.0.1',
  PORT: '3000',
  APP_PASSWORD: randomBytes(24).toString('base64url'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  PIPELINE_API_KEY: randomBytes(32).toString('base64url'),
  DATA_DIR: './data',
};
let result = existing;
for (const [key, value] of Object.entries(defaults)) {
  if (values[key]) continue;
  // Replace empty placeholders only; preserve all existing nonempty values.
  const pattern = new RegExp(`^${key}\\s*=.*$`, 'm');
  if (pattern.test(result)) result = result.replace(pattern, `${key}=${value}`);
  else result += `${result && !result.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
}
writeFileSync(path, result, { mode: 0o600 });
chmodSync(path, 0o600);
console.log('Private configuration is ready in .env. Use its APP_PASSWORD to sign in, or replace it with a password of at least 12 characters. Credentials were not printed.');
