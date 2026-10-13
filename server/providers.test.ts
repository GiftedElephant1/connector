import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getProvider, getProviderSetup, ProviderError, verifyConnection } from './providers.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('unknown provider is rejected before sending credentials', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  assert.throws(() => getProvider('https://attacker.example'), ProviderError);
  await assert.rejects(verifyConnection('custom', { accessToken: 'test-token' }, {}), ProviderError);
  assert.equal(called, false);
});

test('OpenAI verifies using the official model API and returns only public model fields', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return Response.json({ data: [{ id: 'model-one', private: 'omit-this' }] });
  };
  assert.deepEqual(await verifyConnection('openai', { accessToken: 'test-token' }, {}), {
    accountName: 'OpenAI API account', resources: [{ id: 'model-one', name: 'model-one', type: 'model' }],
  });
});

test('Anthropic uses its API key header and pinned API version', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/models?limit=100');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), 'test-token');
    assert.equal(headers.get('anthropic-version'), '2023-06-01');
    assert.equal(headers.has('authorization'), false);
    return Response.json({ data: [{ id: 'claude-example', display_name: 'Claude example' }] });
  };
  const result = await verifyConnection('anthropic', { accessToken: 'test-token' }, {});
  assert.deepEqual(result.resources, [{ id: 'claude-example', name: 'Claude example', type: 'model' }]);
});

test('xAI uses the official API with bearer authentication', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.x.ai/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
    return Response.json({ data: [{ id: 'grok-example' }] });
  };
  const result = await verifyConnection('xai', { accessToken: 'test-token' }, {});
  assert.equal(result.resources[0].id, 'grok-example');
  assert.deepEqual(getProviderSetup('xai', {}), { configured: true, missing: [] });
});

test('upstream error bodies and thrown errors never leak credentials', async () => {
  const secret = 'test-private-api-key';
  globalThis.fetch = async () => Response.json({ error: `Invalid credential ${secret}` }, { status: 401 });
  await assert.rejects(verifyConnection('openai', { accessToken: secret }, {}), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 401);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  globalThis.fetch = async () => { throw new Error(`Network request with ${secret} failed`); };
  await assert.rejects(verifyConnection('openai', { accessToken: secret }, {}), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 502);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('invalid model response cannot be mistaken for a verified connection', async () => {
  globalThis.fetch = async () => Response.json({ error: 'not a model response' });
  await assert.rejects(verifyConnection('openai', { accessToken: 'test-token' }, {}), /unexpected model list/);
});

test('model lists are bounded and malformed records do not escape normalization', async () => {
  globalThis.fetch = async () => Response.json({ data: [null, 'bad', { id: 42 }, ...Array.from({ length: 150 }, (_, n) => ({ id: `model-${n}` }))] });
  const result = await verifyConnection('openai', { accessToken: 'test-token' }, {});
  assert.equal(result.resources.length, 100);
});

test('empty and multiline credentials are rejected without making a request', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json({ data: [] }); };
  for (const accessToken of ['', '   ', 'bad\r\nHeader: value']) {
    await assert.rejects(verifyConnection('openai', { accessToken }, {}), /valid API key/);
  }
  assert.equal(called, false);
});

const metaEnv = { META_APP_ID: 'test-app', META_APP_SECRET: 'test-secret', THREADS_APP_ID: 'threads-app', THREADS_APP_SECRET: 'threads-secret' };

test('Meta OAuth uses state, only requested permissions, and configurable API version', async () => {
  const { createOAuthRequest } = await import('./providers.ts');
  const url = new URL(createOAuthRequest('instagram', { redirectUri: 'https://example.com/api/oauth/instagram/callback', state: 'test-state', codeVerifier: 'test-verifier', env: { ...metaEnv, META_API_VERSION: 'v26.0' } }));
  assert.equal(url.origin, 'https://www.facebook.com');
  assert.equal(url.pathname, '/v26.0/dialog/oauth');
  assert.equal(url.searchParams.get('state'), 'test-state');
  assert.deepEqual(url.searchParams.get('scope')?.split(','), ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights', 'instagram_manage_messages']);
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(getProviderSetup('facebook', {}).configured, false);
  assert.deepEqual(getProviderSetup('facebook', {}).missing, ['META_APP_ID', 'META_APP_SECRET']);
});

test('Facebook verification sends app secret proof and excludes Page access tokens', async () => {
  const { createHmac } = await import('node:crypto');
  const expectedProof = createHmac('sha256', 'test-secret').update('user-token').digest('hex');
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer user-token');
    assert.equal(url.searchParams.get('appsecret_proof'), expectedProof);
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(url.searchParams.get('fields'), 'id,name');
    if (url.pathname.endsWith('/me/accounts')) return Response.json({ data: [{ id: 'page-1', name: 'Test Page', access_token: 'never-store-this' }] });
    return Response.json({ id: 'person-1', name: 'Account owner' });
  };
  assert.deepEqual(await verifyConnection('facebook', { accessToken: 'user-token' }, metaEnv), {
    accountId: 'person-1', accountName: 'Account owner', resources: [{ id: 'page-1', name: 'Test Page', type: 'page' }],
  });
});

test('Instagram verifies linked professional accounts and explains missing linkage', async () => {
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).pathname.endsWith('/me/accounts')) return Response.json({ data: [
      { id: 'page-1', instagram_business_account: { id: 'ig-1', username: 'account_one' } },
      { id: 'page-2', instagram_business_account: { id: 'ig-1', username: 'account_one' } },
      { id: 'page-3' },
    ] });
    return Response.json({ id: 'person-1', name: 'Account owner' });
  };
  const result = await verifyConnection('instagram', { accessToken: 'user-token' }, metaEnv);
  assert.deepEqual(result.resources, [{ id: 'ig-1', name: '@account_one', type: 'instagram-account' }]);
  globalThis.fetch = async (input) => Response.json(new URL(String(input)).pathname.endsWith('/me/accounts') ? { data: [] } : { id: 'person-1', name: 'Account owner' });
  await assert.rejects(verifyConnection('instagram', { accessToken: 'user-token' }, metaEnv), /No Instagram professional account/);
});

test('Meta Business Manager reads businesses and ad accounts without mutation', async () => {
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, undefined);
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith('/businesses')) return Response.json({ data: [{ id: 'business-1', name: 'Business' }] });
    if (path.endsWith('/adaccounts')) return Response.json({ data: [{ id: 'act_1', name: 'Ads account' }] });
    return Response.json({ id: 'person-1', name: 'Account owner' });
  };
  const result = await verifyConnection('meta-business', { accessToken: 'user-token' }, metaEnv);
  assert.equal(paths.length, 3);
  assert.deepEqual(result.resources.map((resource) => resource.type), ['business', 'ad-account']);
});

test('Meta code exchange stores a long-lived token and actual expiry', async () => {
  const { exchangeOAuthCode, refreshCredential } = await import('./providers.ts');
  let requests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(url.searchParams.get('client_secret'), 'test-secret');
    requests += 1;
    if (requests === 1) {
      assert.equal(url.searchParams.get('code'), 'test-code');
      return Response.json({ access_token: 'short-token', expires_in: 3600 });
    }
    assert.equal(url.searchParams.get('grant_type'), 'fb_exchange_token');
    assert.equal(url.searchParams.get('fb_exchange_token'), 'short-token');
    return Response.json({ access_token: 'long-token', expires_in: 5_184_000 });
  };
  const credential = await exchangeOAuthCode('facebook', { code: 'test-code', redirectUri: 'https://example.com/api/oauth/facebook/callback', codeVerifier: 'verifier', env: metaEnv });
  assert.equal(credential.accessToken, 'long-token');
  assert.ok(credential.expiresAt && credential.expiresAt > Date.now() + 5_000_000_000);
  assert.equal(requests, 2);
  await assert.rejects(refreshCredential('facebook', { accessToken: 'expired', expiresAt: Date.now() - 1 }, metaEnv), /expired/);
  assert.equal(requests, 2);
});

test('Threads requires a public HTTPS callback and separate app credentials', async () => {
  const { createOAuthRequest } = await import('./providers.ts');
  const base = { state: 'test-state', codeVerifier: 'test-verifier', env: metaEnv };
  assert.throws(() => createOAuthRequest('threads', { ...base, redirectUri: 'http://localhost:3000/api/oauth/threads/callback' }), /HTTPS callback/);
  const url = new URL(createOAuthRequest('threads', { ...base, redirectUri: 'https://connector.example/api/oauth/threads/callback' }));
  assert.equal(url.origin, 'https://www.threads.com');
  assert.equal(url.searchParams.get('client_id'), 'threads-app');
  assert.equal(url.searchParams.get('scope'), 'threads_basic,threads_content_publish,threads_read_replies,threads_manage_replies,threads_manage_insights');
  assert.equal(url.searchParams.get('state'), 'test-state');
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('Threads exchanges and refreshes long-lived tokens using current official hosts', async () => {
  const { exchangeOAuthCode, refreshCredential } = await import('./providers.ts');
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.threads.com');
    requests += 1;
    if (requests === 1) {
      assert.equal(init?.method, 'POST');
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('client_id'), 'threads-app');
      assert.equal(form.get('client_secret'), 'threads-secret');
      return Response.json({ access_token: 'short-token', user_id: 'profile-1' });
    }
    if (requests === 2) {
      assert.equal(url.searchParams.get('grant_type'), 'th_exchange_token');
      assert.equal(url.searchParams.get('access_token'), 'short-token');
      return Response.json({ access_token: 'long-token', expires_in: 5_184_000 });
    }
    assert.equal(url.searchParams.get('grant_type'), 'th_refresh_token');
    assert.equal(url.searchParams.get('access_token'), 'long-token');
    return Response.json({ access_token: 'renewed-token', expires_in: 5_184_000 });
  };
  const credential = await exchangeOAuthCode('threads', { code: 'code', redirectUri: 'https://connector.example/api/oauth/threads/callback', codeVerifier: 'verifier', env: metaEnv });
  assert.equal(credential.accessToken, 'long-token');
  const refreshed = await refreshCredential('threads', { ...credential, expiresAt: Date.now() + 30_000 }, metaEnv);
  assert.equal(refreshed.accessToken, 'renewed-token');
  await assert.rejects(refreshCredential('threads', { ...credential, expiresAt: Date.now() - 1 }, metaEnv), /expired/);
  assert.equal(requests, 3);
});

test('Threads reads a profile and reports its resource identity', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/v1.0/me');
    assert.equal(url.searchParams.get('fields'), 'id,username,name');
    assert.equal(url.searchParams.get('access_token'), 'user-token');
    return Response.json({ id: 'threads-1', username: 'example', name: 'Example' });
  };
  assert.deepEqual(await verifyConnection('threads', { accessToken: 'user-token' }, metaEnv), {
    accountId: 'threads-1', accountName: 'Example', resources: [{ id: 'threads-1', name: '@example', type: 'threads-profile' }],
  });
});
