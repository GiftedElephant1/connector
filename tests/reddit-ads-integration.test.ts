import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { Store } from '../server/store.ts';

test('Reddit Ads callback distinguishes token and account failures and preserves saved connections until verified', async t => {
  const config: AppConfig = {
    origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000,
    password: 'reddit-integration-test-password', encryptionKey: Buffer.alloc(32, 71),
    databasePath: ':memory:', secureCookies: false,
  };
  const store = new Store(':memory:', config.encryptionKey);
  const env: NodeJS.ProcessEnv = {};
  const app = createApp(config, store, undefined, env);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const appId = 'test-reddit-app';
  const appSecret = 'test-private-secret+/%=&';
  const accountId = 'a2_testaccount';
  const accessToken = 'test-private-access-token';
  let stage: 'exchange' | 'verify' | 'success' = 'exchange';
  let verificationCalls = 0;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith(base)) return realFetch(input, init);
    assert.equal(init?.redirect, 'error');
    if (String(input) === 'https://www.reddit.com/api/v1/access_token') {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`);
      assert.equal(headers.get('user-agent'), 'web:connector:test (by /u/test-owner)');
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('redirect_uri'), `${config.origin}/api/oauth/reddit-ads/callback`);
      assert.equal(body.get('code'), 'test-private-code');
      if (stage === 'exchange') return Response.json({ error: 'invalid_client', error_description: appSecret }, { status: 401 });
      return Response.json({ access_token: accessToken, refresh_token: 'test-private-refresh', expires_in: 3600 });
    }
    assert.equal(String(input), `https://ads-api.reddit.com/api/v3/ad_accounts/${accountId}/campaigns`);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${accessToken}`);
    verificationCalls++;
    if (stage === 'verify') return Response.json({ error: { code: 401, message: accessToken } }, { status: 401 });
    return Response.json({ data: [], pagination: {} });
  });
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, redirect: 'manual' });
  const login = await request('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-connector-request': '1' },
    body: JSON.stringify({ password: config.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, 'content-type': 'application/json', 'x-connector-request': '1' };
  const saved = await request('/api/settings', {
    method: 'PUT', headers, body: JSON.stringify({ values: {
      REDDIT_ADS_CLIENT_ID: appId, REDDIT_ADS_CLIENT_SECRET: appSecret,
      REDDIT_ADS_ACCOUNT_ID: accountId, REDDIT_USER_AGENT: 'web:connector:test (by /u/test-owner)',
    } }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.text()).includes(appSecret), false);
  const previous = { accessToken: 'test-previous-reddit-token' };
  store.save('reddit-ads', previous, { accountName: 'Existing Reddit account', resources: [] });
  store.save('wordpress', { accessToken: 'test-unrelated-token' }, { accountName: 'Existing blog', resources: [] });

  async function attempt() {
    const start = await request('/api/oauth/reddit-ads/start', { method: 'POST', headers });
    assert.equal(start.status, 200);
    const authorization = new URL((await start.json()).url);
    assert.equal(authorization.searchParams.get('client_id'), appId);
    const state = authorization.searchParams.get('state')!;
    const response = await request(`/api/oauth/reddit-ads/callback?state=${encodeURIComponent(state)}&code=test-private-code`, { headers });
    assert.equal(response.status, 302);
    return new URL(response.headers.get('location')!, base);
  }

  const exchangeError = (await attempt()).searchParams.get('error')!;
  assert.match(exchangeError, /authorization code exchange failed \(HTTP 401; OAuth invalid_client\)/);
  assert.equal(verificationCalls, 0);
  assert.deepEqual(store.credential('reddit-ads'), previous);
  stage = 'verify';
  const verifyError = (await attempt()).searchParams.get('error')!;
  assert.match(verifyError, /account verification failed \(HTTP 401; provider code 401\)/);
  assert.doesNotMatch(verifyError, /client secret/);
  assert.equal(verificationCalls, 1);
  assert.deepEqual(store.credential('reddit-ads'), previous);
  for (const error of [exchangeError, verifyError]) {
    for (const secret of [appSecret, accessToken, 'test-private-code', 'test-private-refresh']) assert.equal(error.includes(secret), false);
  }
  stage = 'success';
  assert.equal((await attempt()).searchParams.get('connected'), 'reddit-ads');
  assert.equal(store.credential('reddit-ads')?.accessToken, accessToken);
  assert.equal(store.connection('reddit-ads')?.accountId, accountId);
  assert.equal(store.credential('wordpress')?.accessToken, 'test-unrelated-token');
});
