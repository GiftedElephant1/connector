import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp, type AppOptions, type ProviderService } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import * as providers from '../server/providers.ts';
import { Store } from '../server/store.ts';
import { hydrateSettings, savePassword, saveSettings } from '../server/settings.ts';

const configTemplate: AppConfig = {
  origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000,
  password: 'initial-owner-password', encryptionKey: Buffer.alloc(32, 4),
  databasePath: ':memory:', secureCookies: false, pipelineKey: 'pipeline-key-'.repeat(4),
};
async function fixture(t: TestContext, options: AppOptions = {}, initialEnv: NodeJS.ProcessEnv = {}, serviceOverrides: Partial<ProviderService> = {}, configOverrides: Partial<AppConfig> = {}) {
  const config = { ...configTemplate, ...configOverrides };
  const env = { ...initialEnv };
  const store = new Store(':memory:', config.encryptionKey);
  const app = createApp(config, store, { ...providers, ...serviceOverrides }, env, undefined, options);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Node fetch rewrites Host; use the HTTP client to test the exact local/public host boundary.
  const request = (path: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest(`${base}${path}`, { method: init.method, headers: init.headers as Record<string, string> }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value) for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
      });
    });
    outgoing.once('error', reject);
    if (typeof init.body === 'string') outgoing.write(init.body);
    outgoing.end();
  });
  const mutate = (path: string, body: unknown, cookie = '', headers: Record<string, string> = {}, method = 'POST') => request(path, {
    method, headers: { 'content-type': 'application/json', 'x-connector-request': '1', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body),
  });
  const login = async (password = config.password, headers: Record<string, string> = {}) => {
    const response = await mutate('/api/login', { password }, '', headers);
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  return { config, env, store, request, mutate, login };
}

test('settings and machine key require owner authentication and all settings mutations require CSRF protection', async t => {
  const f = await fixture(t);
  for (const path of ['/api/workspace', '/api/installation', '/api/settings', '/api/settings/providers/discord', '/api/settings/pipeline-key', '/api/tunnel']) {
    const result = await f.request(path);
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await f.mutate('/api/settings', { values: { DISCORD_CLIENT_ID: 'app' } }, '', {}, 'PUT')).status, 401);
  const cookie = await f.login();
  assert.equal((await f.request('/api/settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ values: {} }) })).status, 403);
  assert.equal((await f.mutate('/api/settings', { values: {} }, cookie, { origin: 'https://other.example' }, 'PUT')).status, 403);
  const key = await f.request('/api/settings/pipeline-key', { headers: { cookie } });
  assert.equal(key.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await key.json(), { apiKey: f.config.pipelineKey, url: `${f.config.origin}/mcp`, transport: 'Streamable HTTP' });
});

test('saved provider settings take effect immediately while secret values remain absent from metadata', async t => {
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const f = await fixture(t, {}, {}, {
    createOAuthRequest: (_id, input) => { seenEnv = input.env; return 'https://discord.com/oauth2/authorize'; },
  });
  const cookie = await f.login();
  const secret = 'discord-secret-that-must-stay-private';
  const response = await f.mutate('/api/settings', { values: { DISCORD_CLIENT_ID: 'app-123', DISCORD_CLIENT_SECRET: secret } }, cookie, {}, 'PUT');
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(secret), false);
  assert.equal(f.env.DISCORD_CLIENT_SECRET, secret);
  const snapshot = JSON.parse(text);
  assert.deepEqual(snapshot.fields.find((field: { key: string }) => field.key === 'DISCORD_CLIENT_SECRET'), {
    key: 'DISCORD_CLIENT_SECRET', label: 'Discord client secret', secret: true, configured: true, providerIds: ['discord'],
  });
  const setup = await (await f.request('/api/settings/providers/discord', { headers: { cookie } })).json() as { callbackUrl: string; setupUrl: string; fields: { key: string }[] };
  assert.equal(setup.callbackUrl, `${f.config.origin}/api/oauth/discord/callback`);
  assert.equal(setup.setupUrl, 'https://discord.com/developers/applications');
  assert.ok(setup.fields.some(field => field.key === 'DISCORD_BOT_TOKEN'));
  assert.equal((await f.mutate('/api/oauth/discord/start', {}, cookie)).status, 200);
  assert.equal(seenEnv, f.env);
  assert.equal(seenEnv?.DISCORD_CLIENT_SECRET, secret);
  await f.mutate('/api/settings', { values: { DISCORD_CLIENT_SECRET: '' } }, cookie, {}, 'PUT');
  assert.equal(f.env.DISCORD_CLIENT_SECRET, secret, 'blank secret preserves the saved credential');
  await f.mutate('/api/settings', { values: {}, reset: ['DISCORD_CLIENT_SECRET'] }, cookie, {}, 'PUT');
  assert.equal(f.env.DISCORD_CLIENT_SECRET, '');
});

for (const providerId of ['linkedin', 'linkedin-ads']) {
  test(`${providerId} uses the displayed redirect address for authorization and token exchange after an origin change`, async t => {
    const origins = ['https://connector-before.ngrok-free.dev', 'https://connector-after.ngrok-free.dev'];
    const env = { LINKEDIN_CLIENT_ID: 'test-linkedin-app', LINKEDIN_CLIENT_SECRET: 'test-linkedin-secret' };
    let expectedRedirect = '';
    let exchanges = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), 'https://www.linkedin.com/oauth/v2/accessToken');
      assert.equal(init?.method, 'POST');
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('redirect_uri'), expectedRedirect);
      assert.equal(body.get('client_id'), env.LINKEDIN_CLIENT_ID);
      assert.equal(body.get('client_secret'), env.LINKEDIN_CLIENT_SECRET);
      assert.equal(body.get('code'), 'test-authorization-code');
      exchanges++;
      return Response.json({ access_token: 'test-linkedin-token', expires_in: 3600 });
    });
    const f = await fixture(t, { localOrigin: configTemplate.origin }, env, {
      verifyConnection: async () => ({ accountName: 'Test LinkedIn account', resources: [] }),
    }, { origin: origins[0], secureCookies: true });
    const headers = (origin: string) => ({ host: new URL(origin).host, origin });
    const cookie = await f.login(f.config.password, headers(origins[0]));

    for (const origin of origins) {
      if (f.config.origin !== origin) {
        const updated = await f.mutate('/api/settings', { values: { APP_ORIGIN: origin } }, cookie, headers(f.config.origin), 'PUT');
        assert.equal(updated.status, 200);
      }
      const setupResponse = await f.request(`/api/settings/providers/${providerId}`, { headers: { cookie, ...headers(origin) } });
      assert.equal(setupResponse.status, 200);
      const setup = await setupResponse.json() as { callbackUrl: string };
      expectedRedirect = `${origin}/api/oauth/${providerId}/callback`;
      assert.equal(setup.callbackUrl, expectedRedirect);

      const started = await f.mutate(`/api/oauth/${providerId}/start`, {}, cookie, headers(origin));
      assert.equal(started.status, 200);
      const authorization = new URL((await started.json() as { url: string }).url);
      assert.equal(authorization.origin + authorization.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
      assert.equal(authorization.searchParams.get('client_id'), env.LINKEDIN_CLIENT_ID);
      assert.equal(authorization.searchParams.get('redirect_uri'), setup.callbackUrl);
      assert.equal(authorization.searchParams.has('client_secret'), false);
      const state = authorization.searchParams.get('state');
      assert.ok(state);

      const callback = await f.request(`/api/oauth/${providerId}/callback?state=${state}&code=test-authorization-code`, {
        headers: { cookie, ...headers(origin) },
      });
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.get('location'), `/?connected=${providerId}`);
      assert.equal(f.store.credential(providerId)?.accessToken, 'test-linkedin-token');
    }
    assert.equal(exchanges, origins.length);
  });
}

test('Threads uses corrected saved credentials and safely reports a failed exchange before a fresh successful connection', async t => {
  const origin = 'https://connector.example';
  const f = await fixture(t, {}, {
    THREADS_APP_ID: '111111111111111', THREADS_APP_SECRET: 'old-threads-secret',
    META_APP_ID: '333333333333333', META_APP_SECRET: 'separate-meta-secret',
  }, {}, { origin });
  const headers = { host: new URL(origin).host, origin };
  const cookie = await f.login(undefined, headers);
  const correctedId = '222222222222222';
  const correctedSecret = 'replacement-threads-secret';
  const saved = await f.mutate('/api/settings', {
    values: { THREADS_APP_ID: correctedId, THREADS_APP_SECRET: correctedSecret },
  }, cookie, headers, 'PUT');
  assert.equal(saved.status, 200);
  assert.equal((await saved.text()).includes(correctedSecret), false);

  const start = async () => {
    const response = await f.mutate('/api/oauth/threads/start', {}, cookie, headers);
    assert.equal(response.status, 200);
    const url = new URL((await response.json() as { url: string }).url);
    assert.equal(url.searchParams.get('client_id'), correctedId);
    assert.equal(url.searchParams.get('redirect_uri'), `${origin}/api/oauth/threads/callback`);
    assert.equal(url.searchParams.has('client_secret'), false);
    return url.searchParams.get('state')!;
  };
  let providerRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    providerRequests++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.threads.com');
    if (url.pathname.endsWith('/oauth/access_token')) {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('client_id'), correctedId);
      assert.equal(form.get('client_secret'), correctedSecret);
      assert.equal(form.get('redirect_uri'), `${origin}/api/oauth/threads/callback`);
      if (providerRequests === 1) return Response.json({
        error: { code: 100, error_subcode: 36008, message: `${correctedSecret} private-sign-in-code`, fbtrace_id: 'private-trace' },
      }, { status: 400 });
      return Response.json({ access_token: 'short-threads-token' });
    }
    if (url.pathname.endsWith('/access_token')) {
      assert.equal(url.searchParams.get('client_secret'), correctedSecret);
      return Response.json({ access_token: 'long-threads-token', expires_in: 5_184_000 });
    }
    assert.equal(url.pathname, '/v1.0/me');
    return Response.json({ id: 'threads-user', username: 'test_profile' });
  });

  const firstState = await start();
  const failed = await f.request(`/api/oauth/threads/callback?state=${firstState}&code=private-sign-in-code`, { headers: { cookie, ...headers } });
  assert.equal(failed.status, 302);
  const error = new URL(failed.headers.get('location')!, origin).searchParams.get('error')!;
  assert.match(error, /authorization code exchange/i);
  assert.match(error, /100/);
  assert.match(error, /36008/);
  for (const sensitive of [correctedSecret, 'private-sign-in-code', 'private-trace', firstState]) assert.equal(error.includes(sensitive), false);
  assert.equal(f.store.credential('threads'), null);

  const secondState = await start();
  assert.notEqual(firstState, secondState);
  const success = await f.request(`/api/oauth/threads/callback?state=${secondState}&code=fresh-code`, { headers: { cookie, ...headers } });
  assert.equal(success.status, 302);
  assert.equal(success.headers.get('location'), '/?connected=threads');
  assert.equal(f.store.credential('threads')?.accessToken, 'long-threads-token');
  assert.equal(f.env.META_APP_SECRET, 'separate-meta-secret');
  assert.equal(providerRequests, 4);
});

for (const failure of ['exchange', 'verification'] as const) {
  test(`Microsoft Advertising OAuth ${failure} failure is safely diagnosed and corrected settings work on a fresh attempt`, async t => {
    const origin = 'https://connector.example';
    const initialSettings = {
      MICROSOFT_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
      MICROSOFT_CLIENT_SECRET: 'initial-microsoft-client-secret',
      MICROSOFT_ADS_DEVELOPER_TOKEN: 'initial-advertising-developer-token',
    };
    const correctedSettings = {
      MICROSOFT_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
      MICROSOFT_CLIENT_SECRET: 'corrected-microsoft-client-secret',
      MICROSOFT_ADS_DEVELOPER_TOKEN: 'corrected-advertising-developer-token',
    };
    const f = await fixture(t, {}, initialSettings, {}, { origin });
    const headers = { host: new URL(origin).host, origin };
    const cookie = await f.login(undefined, headers);
    if (failure === 'verification') {
      f.store.save('microsoft-ads', { accessToken: 'previously-verified-access-token', refreshToken: 'previous-refresh-token' }, {
        accountId: 'previous-user', accountName: 'Previously verified account', resources: [],
      });
    }
    const previousCredential = f.store.credential('microsoft-ads');
    const previousConnection = f.store.connection('microsoft-ads');
    let corrected = false;
    let challenge = '';
    let providerRequests = 0;
    const privateDescription = 'private-provider-description https://private.example/?secret=private-url-value';
    const start = async () => {
      const response = await f.mutate('/api/oauth/microsoft-ads/start', {}, cookie, headers);
      assert.equal(response.status, 200);
      const authorization = new URL((await response.json() as { url: string }).url);
      assert.equal(authorization.origin + authorization.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
      assert.equal(authorization.searchParams.get('client_id'), (corrected ? correctedSettings : initialSettings).MICROSOFT_CLIENT_ID);
      assert.equal(authorization.searchParams.get('redirect_uri'), `${origin}/api/oauth/microsoft-ads/callback`);
      assert.equal(authorization.searchParams.has('client_secret'), false);
      challenge = authorization.searchParams.get('code_challenge')!;
      assert.ok(challenge);
      const state = authorization.searchParams.get('state');
      assert.ok(state);
      return state;
    };
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      providerRequests++;
      const settings = corrected ? correctedSettings : initialSettings;
      assert.equal(init?.method, 'POST');
      if (String(input) === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get('client_id'), settings.MICROSOFT_CLIENT_ID);
        assert.equal(form.get('client_secret'), settings.MICROSOFT_CLIENT_SECRET);
        assert.equal(form.get('redirect_uri'), `${origin}/api/oauth/microsoft-ads/callback`);
        assert.equal(form.get('code'), corrected ? 'fresh-private-code' : 'failed-private-code');
        assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), challenge);
        if (!corrected && failure === 'exchange') return Response.json({
          error: 'invalid_client', error_codes: [7000215],
          error_description: `${privateDescription} ${settings.MICROSOFT_CLIENT_SECRET} failed-private-code`,
        }, { status: 401 });
        return Response.json({
          access_token: corrected ? 'corrected-access-token' : 'unverified-access-token',
          refresh_token: corrected ? 'corrected-refresh-token' : 'unverified-refresh-token', expires_in: 3600,
        });
      }
      assert.equal(String(input), 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13/User/Query');
      assert.equal(new Headers(init?.headers).get('developertoken'), settings.MICROSOFT_ADS_DEVELOPER_TOKEN);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${corrected ? 'corrected-access-token' : 'unverified-access-token'}`);
      assert.deepEqual(JSON.parse(String(init?.body)), { UserId: null });
      if (!corrected) return Response.json({ Errors: [{
        Code: 105, ErrorCode: 'InvalidCredentials',
        Message: `${privateDescription} ${settings.MICROSOFT_ADS_DEVELOPER_TOKEN} unverified-access-token`,
      }] }, { status: 401 });
      return Response.json({
        User: { Id: 'verified-user', Name: { FirstName: 'Test', LastName: 'Advertiser' } },
        CustomerRoles: [{ CustomerId: 'verified-customer', AccountIds: ['verified-ad-account'] }],
      });
    });

    const firstState = await start();
    const failedPath = `/api/oauth/microsoft-ads/callback?state=${firstState}&code=failed-private-code`;
    const failed = await f.request(failedPath, { headers: { cookie, ...headers } });
    assert.equal(failed.status, 302);
    const error = new URL(failed.headers.get('location')!, origin).searchParams.get('error')!;
    assert.match(error, failure === 'exchange'
      ? /Microsoft Advertising authorization code exchange failed \(HTTP 401; AADSTS 7000215; OAuth invalid_client\)/
      : /Microsoft Advertising account verification failed \(HTTP 401; provider code 105\)/);
    for (const privateValue of [
      initialSettings.MICROSOFT_CLIENT_SECRET, initialSettings.MICROSOFT_ADS_DEVELOPER_TOKEN,
      privateDescription, 'https://private.example/', 'private-url-value', 'private-provider-description',
      'failed-private-code', 'unverified-access-token', 'unverified-refresh-token', firstState,
    ]) assert.equal(error.includes(privateValue), false, `callback must not expose ${privateValue}`);
    const failedRequestCount = failure === 'exchange' ? 1 : 2;
    assert.equal(providerRequests, failedRequestCount, 'a failed exchange must not proceed to account verification');
    assert.deepEqual(f.store.credential('microsoft-ads'), previousCredential, 'failed credentials must not replace a previously verified connection');
    assert.deepEqual(f.store.connection('microsoft-ads'), previousConnection);

    const replay = await f.request(failedPath, { headers: { cookie, ...headers } });
    assert.equal(replay.status, 302);
    assert.match(new URL(replay.headers.get('location')!, origin).searchParams.get('error')!, /authorization expired|does not belong to your session/i);
    assert.equal(providerRequests, failedRequestCount, 'failed callbacks consume their OAuth state');

    const saved = await f.mutate('/api/settings', { values: correctedSettings }, cookie, headers, 'PUT');
    assert.equal(saved.status, 200);
    const metadata = await saved.text();
    assert.equal(metadata.includes(correctedSettings.MICROSOFT_CLIENT_SECRET), false);
    assert.equal(metadata.includes(correctedSettings.MICROSOFT_ADS_DEVELOPER_TOKEN), false);
    corrected = true;
    const secondState = await start();
    assert.notEqual(secondState, firstState);
    const succeeded = await f.request(`/api/oauth/microsoft-ads/callback?state=${secondState}&code=fresh-private-code`, { headers: { cookie, ...headers } });
    assert.equal(succeeded.status, 302);
    assert.equal(succeeded.headers.get('location'), '/?connected=microsoft-ads');
    assert.equal(providerRequests, failedRequestCount + 2);
    assert.equal(f.store.credential('microsoft-ads')?.accessToken, 'corrected-access-token');
    assert.equal(f.store.credential('microsoft-ads')?.refreshToken, 'corrected-refresh-token');
    assert.equal(f.store.connection('microsoft-ads')?.accountName, 'Test Advertiser');
    assert.deepEqual(f.store.connection('microsoft-ads')?.resources.map(resource => resource.id), ['verified-customer', 'verified-ad-account']);
  });
}

test('settings reject runtime controls, invalid values, and partial changes', async t => {
  const f = await fixture(t);
  const cookie = await f.login();
  for (const values of [
    { DISCORD_CLIENT_ID: 'must-not-save', ENCRYPTION_KEY: 'replacement' },
    { APP_PASSWORD: 'replacement-password' }, { PIPELINE_API_KEY: 'replacement' },
    { NODE_OPTIONS: '--inspect=0.0.0.0' }, { HOST: '0.0.0.0' },
    { DISCORD_BOT_TOKEN: 'secret\nsecond-line' }, { APP_ORIGIN: 'http://public.example' },
    { APP_ORIGIN: 'https://public.example/path' }, { APP_ORIGIN: 'https://user:password@public.example' },
    { APP_ORIGIN: 'http://localhost:6666' },
  ]) assert.equal((await f.mutate('/api/settings', { values }, cookie, {}, 'PUT')).status, 400);
  assert.equal(f.env.DISCORD_CLIENT_ID, undefined);
  assert.equal(f.config.origin, configTemplate.origin);
  assert.equal(f.store.readSetting('provider-overrides'), null);
});

test('provider configuration and owner password are encrypted at rest and survive restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'connector-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'connector.sqlite');
  const secret = 'unique-secret-for-encryption-regression';
  const password = 'unique-owner-password-for-encryption';
  const first = new Store(path, configTemplate.encryptionKey);
  saveSettings({ ...configTemplate }, first, {}, { values: { DISCORD_CLIENT_SECRET: secret, APP_ORIGIN: 'https://connector.example' } }, configTemplate.origin);
  savePassword(first, password);
  first.close();
  const disk = readFileSync(path).toString('utf8');
  assert.equal(disk.includes(secret), false);
  assert.equal(disk.includes(password), false);
  const second = new Store(path, configTemplate.encryptionKey);
  const config = { ...configTemplate };
  const env: NodeJS.ProcessEnv = {};
  hydrateSettings(config, second, env);
  assert.equal(env.DISCORD_CLIENT_SECRET, secret);
  assert.equal(config.origin, 'https://connector.example');
  assert.equal(config.secureCookies, true);
  assert.equal(JSON.stringify(second.readSetting('owner-password')).includes(password), false);
  second.close();
});

test('changing the origin keeps local dashboard access and sets secure cookies only on the public dashboard', async t => {
  const f = await fixture(t);
  const localHeaders = { host: '127.0.0.1:3000', origin: configTemplate.origin };
  const cookie = await f.login();
  const changed = await f.mutate('/api/settings', { values: { APP_ORIGIN: 'https://connector.example' } }, cookie, localHeaders, 'PUT');
  assert.equal(changed.status, 200);
  const snapshot = await changed.json() as { origin: string; localOrigin: string };
  assert.equal(snapshot.origin, 'https://connector.example');
  assert.equal(snapshot.localOrigin, configTemplate.origin);
  const localLogin = await f.mutate('/api/login', { password: f.config.password }, '', localHeaders);
  assert.equal(localLogin.status, 200);
  assert.doesNotMatch(localLogin.headers.get('set-cookie')!, /; Secure/i);
  assert.doesNotMatch(localLogin.headers.get('content-security-policy')!, /upgrade-insecure-requests/);
  const publicLogin = await f.mutate('/api/login', { password: f.config.password }, '', { host: 'connector.example', origin: 'https://connector.example' });
  assert.equal(publicLogin.status, 200);
  assert.match(publicLogin.headers.get('set-cookie')!, /; Secure/i);
  const publicCookie = publicLogin.headers.get('set-cookie')!.split(';')[0];
  const key = await f.request('/api/settings/pipeline-key', { headers: { cookie: publicCookie } });
  assert.equal((await key.json() as { url: string }).url, 'https://connector.example/mcp');
  assert.equal((await f.mutate('/api/login', { password: f.config.password }, '', { origin: 'https://connector.example.attacker.test' })).status, 403);
  await f.mutate('/api/settings', { values: { DISCORD_CLIENT_ID: 'id', DISCORD_CLIENT_SECRET: 'secret' } }, cookie, localHeaders, 'PUT');
  assert.equal((await f.mutate('/api/oauth/discord/start', {}, cookie, localHeaders)).status, 409);
});

test('desktop unlock is a one-use local capability and does not expose the capability', async t => {
  const token = 'desktop-launch-capability-'.repeat(3);
  const f = await fixture(t, { desktopToken: token, localOrigin: configTemplate.origin });
  const health = await f.request('/api/health');
  assert.equal(health.headers.get('x-connector-app'), 'gifted-elephant-connector');
  assert.deepEqual(await health.json(), { status: 'ok', desktopInstance: createHash('sha256').update(token).digest('hex') });
  assert.equal((await f.mutate('/api/desktop/unlock', { token }, '', { host: 'public.example' })).status, 401);
  assert.equal((await f.mutate('/api/desktop/unlock', { token: 'incorrect' }, '', { host: '127.0.0.1:3000' })).status, 401);
  const result = await f.mutate('/api/desktop/unlock', { token }, '', { host: '127.0.0.1:3000', origin: configTemplate.origin });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true });
  const cookie = result.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await f.request('/api/settings', { headers: { cookie } })).status, 200);
  assert.equal((await f.mutate('/api/desktop/unlock', { token }, '', { host: '127.0.0.1:3000' })).status, 401);
});

test('desktop bootstrap is disabled without a strong launch capability and rejects expired links', async t => {
  const disabled = await fixture(t, { desktopToken: 'too-short' });
  assert.equal((await disabled.mutate('/api/desktop/unlock', { token: 'too-short' }, '', { host: '127.0.0.1:3000' })).status, 401);
  const token = 'desktop-launch-capability-'.repeat(3);
  const expired = await fixture(t, { desktopToken: token });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(10 * 60_000 + 1);
  assert.equal((await expired.mutate('/api/desktop/unlock', { token }, '', { host: '127.0.0.1:3000' })).status, 401);
  t.mock.timers.reset();
});

test('owner password setup rotates sessions and replaces the generated password', async t => {
  const f = await fixture(t);
  const first = await f.login();
  const second = await f.login();
  const before = await (await f.request('/api/settings', { headers: { cookie: first } })).json() as { passwordConfigured: boolean };
  assert.equal(before.passwordConfigured, false);
  assert.equal((await f.mutate('/api/settings/password', { password: 'short' }, first)).status, 400);
  const password = 'a-new-owner-password';
  const changed = await f.mutate('/api/settings/password', { password }, first);
  assert.equal(changed.status, 200);
  const current = changed.headers.get('set-cookie')!.split(';')[0];
  assert.notEqual(first, current);
  for (const cookie of [first, second]) assert.equal((await f.request('/api/settings', { headers: { cookie } })).status, 401);
  assert.equal((await f.mutate('/api/login', { password: configTemplate.password })).status, 401);
  const cookie = await f.login(password);
  const after = await (await f.request('/api/settings', { headers: { cookie } })).json() as { passwordConfigured: boolean };
  assert.equal(after.passwordConfigured, true);
});

test('desktop launch canonicalizes the default localhost origin without replacing a public HTTPS origin', async t => {
  const desktop = await fixture(t, { localOrigin: configTemplate.origin }, {}, {}, { origin: 'http://localhost:3000' });
  assert.equal(desktop.config.origin, configTemplate.origin);
  assert.equal(desktop.env.APP_ORIGIN, configTemplate.origin);
  const cookie = await desktop.login();
  const settings = await (await desktop.request('/api/settings', { headers: { cookie } })).json() as { origin: string; localOrigin: string };
  assert.equal(settings.origin, settings.localOrigin);
  const hosted = await fixture(t, { localOrigin: configTemplate.origin }, {}, {}, { origin: 'https://connector.example', secureCookies: true });
  assert.equal(hosted.config.origin, 'https://connector.example');
});
