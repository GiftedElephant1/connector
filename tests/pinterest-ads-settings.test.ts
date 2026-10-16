import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../server/config.ts';
import { getProvider, getProviderSetup } from '../server/providers.ts';
import { clearProviderSettings, hydrateSettings, providerSettingKeys, providerSettings, saveSettings, settingsSnapshot } from '../server/settings.ts';
import { Store } from '../server/store.ts';

const config: AppConfig = {
  origin: 'https://connector.example', host: '127.0.0.1', port: 3000,
  password: 'owner-test-password', encryptionKey: Buffer.alloc(32, 7),
  databasePath: ':memory:', secureCookies: true, pipelineKey: 'test-pipeline-key',
};

test('Pinterest Ads credentials survive restart without changing existing organic credentials or connections', t => {
  const store = new Store(':memory:', config.encryptionKey);
  t.after(() => store.close());
  const env: NodeJS.ProcessEnv = { PINTEREST_CLIENT_ID: 'organic-app', PINTEREST_CLIENT_SECRET: 'organic-secret' };
  const organic = store.save('pinterest', { accessToken: 'organic-access' }, { accountName: 'Organic Pinterest', resources: [] });
  assert.equal(getProviderSetup('pinterest-ads', env).configured, false, 'organic setup must not imply advertising setup');
  saveSettings(config, store, env, { values: { PINTEREST_ADS_CLIENT_ID: 'ads-app', PINTEREST_ADS_CLIENT_SECRET: 'ads-secret' } });
  assert.equal(getProviderSetup('pinterest-ads', env).configured, true);
  assert.equal(env.PINTEREST_CLIENT_ID, 'organic-app');
  assert.equal(env.PINTEREST_CLIENT_SECRET, 'organic-secret');
  assert.deepEqual(store.connection('pinterest'), organic);
  assert.equal(store.credential('pinterest')?.accessToken, 'organic-access');
  assert.equal(store.connection('pinterest-ads'), null, 'saving an application must not fabricate ad account access');

  const restarted = { PINTEREST_CLIENT_ID: 'organic-app', PINTEREST_CLIENT_SECRET: 'organic-secret' } as NodeJS.ProcessEnv;
  hydrateSettings({ ...config }, store, restarted);
  assert.equal(restarted.PINTEREST_ADS_CLIENT_ID, 'ads-app');
  assert.equal(restarted.PINTEREST_ADS_CLIENT_SECRET, 'ads-secret');
  saveSettings(config, store, restarted, { values: { PINTEREST_ADS_CLIENT_SECRET: '' } });
  assert.equal(restarted.PINTEREST_ADS_CLIENT_SECRET, 'ads-secret');
  clearProviderSettings(store, restarted, providerSettingKeys('pinterest-ads'));
  assert.equal(getProviderSetup('pinterest-ads', restarted).configured, false);
  assert.equal(getProviderSetup('pinterest', restarted).configured, true);
  assert.equal(restarted.PINTEREST_CLIENT_SECRET, 'organic-secret');
  assert.deepEqual(store.connection('pinterest'), organic);
});

test('Pinterest Ads setup exposes its own callback and configured-secret status without leaking secret values', t => {
  const store = new Store(':memory:', config.encryptionKey);
  t.after(() => store.close());
  const env = { PINTEREST_ADS_CLIENT_ID: 'ads-app', PINTEREST_ADS_CLIENT_SECRET: 'must-never-be-returned' };
  const setup = providerSettings(getProvider('pinterest-ads'), config, env);
  assert.equal(setup.callbackUrl, 'https://connector.example/api/oauth/pinterest-ads/callback');
  assert.equal(setup.setupUrl, 'https://developers.pinterest.com/');
  assert.deepEqual(setup.fields.map(field => field.key), ['PINTEREST_ADS_CLIENT_ID', 'PINTEREST_ADS_CLIENT_SECRET']);
  assert.ok(setup.fields.every(field => field.required));
  const secret = setup.fields.find(field => field.key === 'PINTEREST_ADS_CLIENT_SECRET');
  assert.equal(secret?.configured, true);
  assert.equal(secret?.secret, true);
  assert.equal(secret?.value, undefined);
  assert.equal(JSON.stringify(setup).includes(env.PINTEREST_ADS_CLIENT_SECRET), false);
  assert.equal(JSON.stringify(settingsSnapshot(config, store, env)).includes(env.PINTEREST_ADS_CLIENT_SECRET), false);
  assert.deepEqual(secret?.providerIds, ['pinterest-ads']);
});
