import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../server/config.ts';

const valid = { APP_PASSWORD: 'a-long-test-password', ENCRYPTION_KEY: 'ab'.repeat(32) };

test('configuration defaults to loopback and uses a 32-byte encryption key', () => {
  const config = loadConfig(valid);
  assert.equal(config.origin, 'http://localhost:3000');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.secureCookies, false);
  assert.equal(config.encryptionKey.length, 32);
  assert.equal(config.encryptionKey.toString('hex'), valid.ENCRYPTION_KEY);
});

test('configuration refuses weak or missing authentication and malformed encryption keys', () => {
  for (const APP_PASSWORD of [undefined, '', 'short']) {
    assert.throws(() => loadConfig({ ...valid, APP_PASSWORD }), /APP_PASSWORD/);
  }
  for (const ENCRYPTION_KEY of [undefined, '', 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32)]) {
    assert.throws(() => loadConfig({ ...valid, ENCRYPTION_KEY }), /ENCRYPTION_KEY/);
  }
});

test('remote origins require HTTPS and may not carry paths or credentials', () => {
  for (const APP_ORIGIN of [
    'http://connector.example', 'ftp://localhost', 'https://connector.example/app',
    'https://connector.example/?query=yes', 'https://connector.example/#secret',
    'https://user:password@connector.example',
  ]) {
    assert.throws(() => loadConfig({ ...valid, APP_ORIGIN }));
  }
  const remote = loadConfig({ ...valid, APP_ORIGIN: 'https://connector.example:8443' });
  assert.equal(remote.origin, 'https://connector.example:8443');
  assert.equal(remote.secureCookies, true);
  for (const APP_ORIGIN of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(loadConfig({ ...valid, APP_ORIGIN }).secureCookies, false);
  }
});

test('invalid listen ports fail before startup', () => {
  for (const PORT of ['0', '-1', '65536', '12.5', 'not-a-port']) {
    assert.throws(() => loadConfig({ ...valid, PORT }), /PORT/);
  }
});
