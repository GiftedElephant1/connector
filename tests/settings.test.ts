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

test('settings reject runtime controls, invalid values, and partial changes', async t => {
  const f = await fixture(t);
  const cookie = await f.login();
  for (const values of [
    { DISCORD_CLIENT_ID: 'must-not-save', ENCRYPTION_KEY: 'replacement' },
    { APP_PASSWORD: 'replacement-password' }, { PIPELINE_API_KEY: 'replacement' },
    { NODE_OPTIONS: '--inspect=0.0.0.0' }, { HOST: '0.0.0.0' },
    { PLAID_ENV: 'development' }, { PLAID_COUNTRY_CODES: 'US,invalid' },
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
  assert.equal((await f.mutate('/api/plaid/link-token', {}, cookie, localHeaders)).status, 409);
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

test('connected Plaid credentials cannot be accidentally switched to another environment or client', async t => {
  const f = await fixture(t, {}, { PLAID_CLIENT_ID: 'client-1', PLAID_SECRET: 'old-secret' });
  f.store.save('plaid', { accessToken: 'bank-access-token' }, { accountName: 'Test bank', resources: [] });
  const cookie = await f.login();
  for (const values of [{ PLAID_ENV: 'production' }, { PLAID_CLIENT_ID: 'client-2' }]) {
    assert.equal((await f.mutate('/api/settings', { values }, cookie, {}, 'PUT')).status, 409);
  }
  assert.equal((await f.mutate('/api/settings', { values: { PLAID_SECRET: 'rotated-secret' } }, cookie, {}, 'PUT')).status, 200);
  assert.equal(f.env.PLAID_SECRET, 'rotated-secret');
});

test('Plaid settings cannot change while an exchange is saving an Item and bound settings can be restored', async t => {
  const f = await fixture(t, {}, { PLAID_CLIENT_ID: 'client-1', PLAID_SECRET: 'old-secret' });
  const cookie = await f.login();
  let beginExchange!: () => void;
  let finishExchange!: () => void;
  const started = new Promise<void>(resolve => { beginExchange = resolve; });
  const finish = new Promise<void>(resolve => { finishExchange = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    let body: unknown;
    if (path === '/link/token/create') body = { link_token: 'link-sandbox-test', expiration: new Date(Date.now() + 3600_000).toISOString() };
    else if (path === '/item/public_token/exchange') {
      beginExchange();
      await finish;
      body = { access_token: 'access-sandbox-test', item_id: 'item-1' };
    } else if (path === '/accounts/get') body = { item: { item_id: 'item-1' }, accounts: [{ account_id: 'bank-1', name: 'Checking', mask: '1234' }] };
    else throw new Error('Unexpected Plaid request.');
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  const start = await f.mutate('/api/plaid/link-token', {}, cookie);
  assert.equal(start.status, 200);
  const { flowId } = await start.json() as { flowId: string };
  const exchange = f.mutate('/api/plaid/exchange', { flowId, publicToken: 'public-sandbox-test' }, cookie);
  await started;
  try {
    for (const values of [{ PLAID_ENV: 'production' }, { PLAID_SECRET: 'new-secret' }, { PLAID_COUNTRY_CODES: 'CA' }]) {
      assert.equal((await f.mutate('/api/settings', { values }, cookie, {}, 'PUT')).status, 409);
    }
  } finally { finishExchange(); }
  assert.equal((await exchange).status, 200);
  assert.equal(f.store.credential('plaid')?.fields?.plaidEnvironment, 'sandbox');
  f.env.PLAID_ENV = 'production'; // Simulate an old .env change before a GUI restart.
  assert.equal((await f.mutate('/api/settings', { values: { PLAID_ENV: 'sandbox' } }, cookie, {}, 'PUT')).status, 200);
  assert.equal(f.env.PLAID_ENV, 'sandbox');
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
