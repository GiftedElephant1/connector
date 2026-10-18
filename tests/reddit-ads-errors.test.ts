import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adsAdapters } from '../server/providers-ads.ts';
import { ProviderError } from '../server/provider-types.ts';

const reddit = adsAdapters.find(adapter => adapter.definition.id === 'reddit-ads')!;
const env = {
  REDDIT_ADS_CLIENT_ID: 'private-app-id', REDDIT_ADS_CLIENT_SECRET: 'private-secret+&=/%:value',
  REDDIT_ADS_ACCOUNT_ID: 't2_privateaccount', REDDIT_USER_AGENT: 'web:private-connector:1.0 (by /u/privateuser)',
};
const credential = { accessToken: 'private-access-token', refreshToken: 'private-refresh-token+&=/%' };
const input = { env, code: 'private-code+&=/%', codeVerifier: 'private-verifier', redirectUri: 'https://private-callback.example/api/oauth/reddit-ads/callback' };
const basic = Buffer.from(`${env.REDDIT_ADS_CLIENT_ID}:${env.REDDIT_ADS_CLIENT_SECRET}`).toString('base64');
const privateValues = [...Object.values(env), ...Object.values(credential), input.code, input.codeVerifier, input.redirectUri, basic, 'private-provider-message', 'private-request-id'];
const privateText = privateValues.join(' ');
const stages = [
  { label: 'authorization code exchange', run: () => reddit.exchange!(input) },
  { label: 'token refresh', run: () => reddit.refresh!(credential, env) },
  { label: 'account verification', run: () => reddit.verify(credential, env) },
];

async function failure(run: () => Promise<unknown>, pattern: RegExp, status = 401): Promise<string> {
  let message = '';
  await assert.rejects(run(), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, status);
    message = error.message;
    assert.match(message, pattern);
    for (const value of privateValues) assert.equal(message.includes(value), false, `Leaked ${value}`);
    return true;
  });
  return message;
}

test('Reddit Ads identifies rejected app credentials at exchange and refresh without upstream text', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: 'invalid_client', error_description: privateText, access_token: credential.accessToken,
    message: privateText, request_id: 'private-request-id', code: 999, error_codes: [7000215],
  }, { status: 401 }));
  for (const stage of stages.slice(0, 2)) {
    const message = await failure(stage.run, new RegExp(`${stage.label} failed \\(HTTP 401; OAuth invalid_client\\)`));
    assert.match(message, /client ID and generated client secret belong to the same Reddit Ads developer application/);
    assert.doesNotMatch(message, /999|7000215|AADSTS/);
  }
});

test('Reddit Ads separates successful token exchange from rejection during account verification', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(url);
    if (url === 'https://www.reddit.com/api/v1/access_token') return Response.json({ access_token: credential.accessToken, refresh_token: credential.refreshToken });
    assert.equal(url, `https://ads-api.reddit.com/api/v3/ad_accounts/${env.REDDIT_ADS_ACCOUNT_ID}/campaigns`);
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${credential.accessToken}`);
    return Response.json({ error: { message: privateText, code: 401 } }, { status: 401 });
  });
  const token = await reddit.exchange!(input);
  const message = await failure(() => reddit.verify(token, env), /account verification failed \(HTTP 401; provider code 401\)/);
  assert.match(message, /rejected the access token.*fresh Connect account attempt/);
  assert.doesNotMatch(message, /client secret|OAuth invalid_client/);
  assert.equal(calls.length, 2);
});

test('Reddit Ads keeps Basic secrets and form parameters exact through exchange and refresh', async t => {
  let requestNumber = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://www.reddit.com/api/v1/access_token');
    assert.equal(init.method, 'POST');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Basic ${basic}`);
    assert.equal(headers.get('user-agent'), env.REDDIT_USER_AGENT);
    assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
    assert.equal(init.redirect, 'error');
    assert.ok(init.body instanceof URLSearchParams);
    assert.equal(init.body.has('client_secret'), false);
    if (requestNumber++ === 0) {
      assert.deepEqual([...init.body], [['grant_type', 'authorization_code'], ['code', input.code], ['redirect_uri', input.redirectUri]]);
    } else {
      assert.deepEqual([...init.body], [['grant_type', 'refresh_token'], ['refresh_token', credential.refreshToken]]);
    }
    return Response.json({ access_token: credential.accessToken, refresh_token: credential.refreshToken });
  });
  assert.equal((await reddit.exchange!(input)).accessToken, credential.accessToken);
  assert.equal((await reddit.refresh!(credential, env)).refreshToken, credential.refreshToken);
  assert.equal(requestNumber, 2);
});

test('Reddit Ads permission and account errors give guidance without assuming legacy approval or a bad secret', async t => {
  let status = 403;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: privateText } }, { status }));
  const denied = await failure(stages[2].run, /account verification failed \(HTTP 403\)/, 403);
  assert.match(denied, /authorized Reddit user.*adsread and adsedit/);
  assert.doesNotMatch(denied, /app approval|client secret|allowlist/);
  status = 404;
  const missing = await failure(stages[2].run, /account verification failed \(HTTP 404\)/, 502);
  assert.match(missing, /ad account identifier, not the business ID or app client ID/);
});

test('Reddit Ads never exposes arbitrary OAuth errors, numeric strings, malformed or oversized bodies', async t => {
  let response: () => Response;
  t.mock.method(globalThis, 'fetch', async () => response());
  for (const value of ['401', privateText, -1, 1.5, 2_147_483_648, true, null, {}, []]) {
    response = () => Response.json({ error: { code: value, message: privateText }, error_description: privateText }, { status: 401 });
    for (const stage of stages) {
      const message = await failure(stage.run, new RegExp(`${stage.label} failed \\(HTTP 401\\)`));
      assert.doesNotMatch(message, /provider code|OAuth /);
    }
  }
  for (const body of [privateText, '[]', JSON.stringify({ error: 'invalid_client', error_description: 'x'.repeat(16_384) })]) {
    response = () => new Response(body, { status: 401 });
    await failure(stages[0].run, /authorization code exchange failed \(HTTP 401\)/);
  }
  response = () => Response.json({ error: privateText, error_description: privateText }, { status: 401 });
  await failure(stages[0].run, /authorization code exchange failed \(HTTP 401\)/);
  response = () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error(privateText)); } }), { status: 401 });
  await failure(stages[0].run, /authorization code exchange failed \(HTTP 401\)/);
});

test('Reddit Ads preserves request stage for network, malformed-success, rate limit and service failures', async t => {
  let mode: 'network' | 'json' | 'shape' | 'missing' | number = 'network';
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'network') throw new Error(privateText);
    if (mode === 'json') return new Response(privateText);
    if (mode === 'shape') return Response.json([privateText]);
    if (mode === 'missing') return Response.json({ access_token: ' ', data: null, error_description: privateText });
    return Response.json({ error_description: privateText }, { status: mode });
  });
  for (const stage of stages) {
    for (const value of ['network', 'json', 'shape', 'missing', 400, 403, 429, 500] as const) {
      mode = value;
      const pattern = typeof value === 'number' ? `failed \\(HTTP ${value}\\)` : value === 'network' ? 'could not reach Reddit' : 'returned an invalid response';
      const message = await failure(stage.run, new RegExp(`${stage.label} ${pattern}`), value === 403 || value === 429 ? value : 502);
      if (value === 429) assert.match(message, /rate limiting/);
      if (value === 500 || value === 429) assert.doesNotMatch(message, /client secret|client ID|account ID/);
    }
  }
});

test('Reddit Ads distinguishes OAuth grant and scope failures from client-credential failures', async t => {
  let error: string;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error, error_description: privateText }, { status: 400 }));
  error = 'invalid_grant';
  await failure(stages[0].run, /OAuth invalid_grant.*authorization grant.*fresh Connect account attempt/, 502);
  await failure(stages[1].run, /OAuth invalid_grant.*saved refresh grant/, 502);
  error = 'invalid_scope';
  await failure(stages[0].run, /OAuth invalid_scope.*adsread and adsedit/, 502);
  error = 'temporarily_unavailable';
  const message = await failure(stages[0].run, /OAuth temporarily_unavailable.*temporary service error/, 502);
  assert.doesNotMatch(message, /client secret|client ID/);
});
