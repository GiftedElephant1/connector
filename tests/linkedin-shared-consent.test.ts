import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { Store } from '../server/store.ts';

type LinkedInProvider = 'linkedin' | 'linkedin-ads';
const member = { id: 'shared-consent-member', name: 'A.J. Denham', type: 'profile' };
const page = { id: 'urn:li:organization:123', name: 'Vectre Pay', type: 'organization' };
const adAccount = { id: '456', name: 'Vectre Pay advertising', type: 'ad_account' };
const socialScopes = ['openid', 'profile', 'w_member_social', 'rw_organization_admin', 'r_organization_social', 'w_organization_social'];
const advertisingScopes = ['r_ads', 'rw_ads', 'r_ads_reporting'];
const scopeSet = (scope: string) => [...new Set(scope.split(/\s+/).filter(Boolean))].sort();

async function fixture(t: TestContext) {
  const config: AppConfig = {
    origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000,
    password: 'shared-consent-owner', encryptionKey: Buffer.alloc(32, 47),
    databasePath: ':memory:', secureCookies: false, pipelineKey: 'shared-consent-pipeline-key-'.repeat(3),
  };
  const env: NodeJS.ProcessEnv = {
    LINKEDIN_CLIENT_ID: 'shared-linkedin-app', LINKEDIN_CLIENT_SECRET: 'private-shared-app-secret',
    LINKEDIN_ENABLE_ORGANIZATIONS: 'true', LINKEDIN_API_VERSION: '202609',
  };
  const store = new Store(':memory:', config.encryptionKey);
  const credentials = {
    linkedin: { accessToken: 'previous-social-token', fields: { scope: socialScopes.join(' ') } },
    'linkedin-ads': { accessToken: 'previous-advertising-token' },
    facebook: { accessToken: 'unrelated-facebook-token' },
  };
  const connections = {
    linkedin: store.save('linkedin', credentials.linkedin, { accountId: member.id, accountName: member.name, resources: [member, page] }),
    'linkedin-ads': store.save('linkedin-ads', credentials['linkedin-ads'], { accountName: 'LinkedIn advertising access', resources: [adAccount] }),
    facebook: store.save('facebook', credentials.facebook, { accountId: 'facebook-user', accountName: member.name, resources: [{ id: '789', name: 'Vectre Pay', type: 'page' }] }),
  };
  const app = createApp(config, store, undefined, env);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = `connector_session=${store.createSession()}`;
  const originalFetch = globalThis.fetch;
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });
  const ownerMutation = (path: string, body: unknown, method = 'POST') => request(path, {
    method, headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify(body),
  });
  const grants = new Map<string, { provider: LinkedInProvider; scope: string }>();
  const liveTokens = new Map<string, Set<string>>();
  const upstreamRequests: { path: string; token: string }[] = [];
  let previousGrant = '';
  let issued = 0;
  let rejectExchange = false;

  // Model LinkedIn's documented app/member grant behavior: changing the scope
  // set invalidates earlier tokens, while another grant of the same set does not.
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === base) return originalFetch(input, init);
    if (url.origin === 'https://www.linkedin.com') {
      assert.equal(url.pathname, '/oauth/v2/accessToken');
      assert.equal(init?.method, 'POST');
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('client_id'), env.LINKEDIN_CLIENT_ID);
      assert.equal(form.get('client_secret'), env.LINKEDIN_CLIENT_SECRET);
      const grant = grants.get(form.get('code')!);
      assert.ok(grant, 'only a code from an actual authorization start may be exchanged');
      assert.equal(form.get('redirect_uri'), `${config.origin}/api/oauth/${grant.provider}/callback`);
      if (rejectExchange) return Response.json({ error: 'invalid_grant', error_description: 'private-upstream-detail' }, { status: 400 });
      const key = scopeSet(grant.scope).join(' ');
      if (previousGrant !== key) liveTokens.clear();
      previousGrant = key;
      const accessToken = `issued-private-token-${++issued}`;
      liveTokens.set(accessToken, new Set(scopeSet(grant.scope)));
      return Response.json({ access_token: accessToken, expires_in: 3600, scope: grant.scope });
    }
    assert.equal(url.origin, 'https://api.linkedin.com', 'requests stay on the official LinkedIn API');
    assert.equal(init?.redirect, 'error');
    assert.ok(!init?.method || init.method === 'GET', 'this regression must never publish or change advertising');
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') || '';
    upstreamRequests.push({ path: url.pathname, token });
    const scopes = liveTokens.get(token);
    if (!scopes) return Response.json({ message: 'REVOKED_ACCESS_TOKEN' }, { status: 401 });
    if (url.pathname === '/v2/userinfo') {
      assert.ok(scopes.has('openid'));
      return Response.json({ sub: member.id, name: member.name });
    }
    assert.equal(new Headers(init?.headers).get('LinkedIn-Version'), '202609');
    if (url.pathname === '/rest/organizationAcls') {
      assert.ok(scopes.has('rw_organization_admin'));
      return Response.json({ elements: [{ organization: page.id, role: 'ADMINISTRATOR', state: 'APPROVED' }] });
    }
    if (url.pathname === '/rest/organizations/123') return Response.json({ id: 123, localizedName: page.name });
    if (url.pathname === '/rest/posts') {
      assert.ok(scopes.has('r_organization_social'));
      assert.equal(url.searchParams.get('author'), page.id);
      return Response.json({ elements: [{ id: 'urn:li:share:321', author: page.id, commentary: 'Live company update', lifecycleState: 'PUBLISHED' }] });
    }
    if (url.pathname === '/rest/adAccounts') {
      assert.ok(scopes.has('r_ads'));
      return Response.json({ elements: [{ id: 456, name: adAccount.name }] });
    }
    assert.equal(url.pathname, '/rest/adAccounts/456/adCampaigns');
    assert.ok(scopes.has('r_ads'));
    return Response.json({ elements: [{ id: 654, name: 'Live campaign', status: 'PAUSED' }] });
  });

  const start = async (provider: LinkedInProvider) => {
    const response = await ownerMutation(`/api/oauth/${provider}/start`, {});
    assert.equal(response.status, 200);
    const url = new URL((await response.json() as { url: string }).url);
    assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
    assert.equal(url.searchParams.get('client_id'), env.LINKEDIN_CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), `${config.origin}/api/oauth/${provider}/callback`);
    assert.equal(url.searchParams.has('client_secret'), false);
    const state = url.searchParams.get('state')!;
    assert.ok(state);
    const scope = url.searchParams.get('scope')!;
    const code = `consent-code-${grants.size + 1}`;
    grants.set(code, { provider, scope });
    return { provider, state, code, scope };
  };
  const callback = (grant: Awaited<ReturnType<typeof start>>, declined = false) => request(
    `/api/oauth/${grant.provider}/callback?state=${grant.state}&${declined ? 'error=access_denied' : `code=${grant.code}`}`,
    { headers: { cookie } },
  );
  const connect = async (provider: LinkedInProvider) => {
    const grant = await start(provider);
    const response = await callback(grant);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/?connected=${provider}`);
    return grant;
  };
  const read = (provider: LinkedInProvider, action: string, values: Record<string, string>) => request(`/api/v1/actions/${provider}/${action}`, {
    method: 'POST', headers: { authorization: `Bearer ${config.pipelineKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ values }),
  });
  const assertUnchanged = (provider: keyof typeof connections) => {
    assert.deepEqual(store.connection(provider), connections[provider]);
    assert.deepEqual(store.credential(provider), credentials[provider]);
  };
  const enableCombinedConsent = async () => {
    const response = await ownerMutation('/api/settings', { values: { LINKEDIN_COMBINE_SCOPES: 'true' } }, 'PUT');
    assert.equal(response.status, 200);
    assert.equal(store.readSetting<Record<string, string>>('provider-overrides')?.LINKEDIN_COMBINE_SCOPES, 'true');
    for (const provider of ['linkedin', 'linkedin-ads', 'facebook'] as const) assertUnchanged(provider);
  };
  return { config, store, request, ownerMutation, cookie, start, callback, connect, read, assertUnchanged, enableCombinedConsent, upstreamRequests, rejectExchange: () => { rejectExchange = true; } };
}

test('separate legacy LinkedIn grants reproduce cached Page visibility with rejected live reads after advertising consent', async t => {
  const f = await fixture(t);
  const social = await f.connect('linkedin');
  assert.deepEqual(scopeSet(social.scope), [...socialScopes].sort());
  assert.equal((await f.read('linkedin', 'organization-posts', { organizationUrn: page.id })).status, 200);
  const advertising = await f.connect('linkedin-ads');
  assert.deepEqual(scopeSet(advertising.scope), [...advertisingScopes].sort());
  assert.deepEqual(f.store.connection('linkedin')?.resources, [member, page], 'cached resources are not proof that a token still works');
  const denied = await f.read('linkedin', 'organization-posts', { organizationUrn: page.id });
  assert.ok(denied.status >= 400);
  assert.equal((await f.read('linkedin-ads', 'list-campaigns', { accountId: adAccount.id })).status, 200);
  f.assertUnchanged('facebook');
});

for (const order of [['linkedin', 'linkedin-ads'], ['linkedin-ads', 'linkedin']] as const) {
  test(`combined LinkedIn consent preserves live Page and ad reads when connecting ${order.join(' then ')}`, async t => {
    const f = await fixture(t);
    await f.enableCombinedConsent();
    for (const provider of order) {
      const setup = await f.request(`/api/settings/providers/${provider}`, { headers: { cookie: f.cookie } });
      assert.equal(setup.status, 200);
      const settings = await setup.json() as { fields: { key: string; value?: string }[] };
      assert.equal(settings.fields.find(field => field.key === 'LINKEDIN_COMBINE_SCOPES')?.value, 'true');
      for (const flag of ['LINKEDIN_ENABLE_ORGANIZATIONS', 'LINKEDIN_ENABLE_MEMBER_READ', 'LINKEDIN_ENABLE_CONVERSIONS']) {
        assert.ok(settings.fields.some(field => field.key === flag), `${provider} must expose shared consent controls`);
      }
    }
    const first = await f.connect(order[0]);
    f.assertUnchanged(order[1]);
    const firstCredential = f.store.credential(order[0]);
    const firstConnection = f.store.connection(order[0]);
    const second = await f.connect(order[1]);
    assert.deepEqual(scopeSet(first.scope), [...socialScopes, ...advertisingScopes].sort());
    assert.equal(second.scope, first.scope, 'both callbacks must request the same consent set');
    assert.deepEqual(f.store.credential(order[0]), firstCredential, 'reconnecting one entry must never overwrite the other token');
    assert.deepEqual(f.store.connection(order[0]), firstConnection);
    assert.notEqual(f.store.credential('linkedin')?.accessToken, f.store.credential('linkedin-ads')?.accessToken);
    assert.deepEqual(f.store.connection('linkedin')?.resources, [member, page]);
    assert.deepEqual(f.store.connection('linkedin-ads')?.resources, [adAccount]);
    const posts = await f.read('linkedin', 'organization-posts', { organizationUrn: page.id });
    assert.equal(posts.status, 200);
    const postText = await posts.text();
    assert.equal(JSON.parse(postText).result.items[0].text, 'Live company update');
    const campaigns = await f.read('linkedin-ads', 'list-campaigns', { accountId: adAccount.id });
    assert.equal(campaigns.status, 200);
    const campaignText = await campaigns.text();
    assert.equal(JSON.parse(campaignText).result.items[0].name, 'Live campaign');
    assert.ok(f.upstreamRequests.some(call => call.path === '/rest/posts' && call.token === f.store.credential('linkedin')?.accessToken));
    assert.ok(f.upstreamRequests.some(call => call.path === '/rest/adAccounts/456/adCampaigns' && call.token === f.store.credential('linkedin-ads')?.accessToken));
    assert.doesNotMatch(postText + campaignText, /issued-private-token|private-shared-app-secret/);
    assert.equal(f.store.jobs().length, 0);
    f.assertUnchanged('facebook');
  });
}

for (const provider of ['linkedin', 'linkedin-ads'] as const) {
  for (const failure of ['declined', 'exchange-rejected'] as const) {
    test(`failed combined ${provider} reconnect (${failure}) preserves both existing connections`, async t => {
      const f = await fixture(t);
      await f.enableCombinedConsent();
      const grant = await f.start(provider);
      if (failure === 'exchange-rejected') f.rejectExchange();
      const response = await f.callback(grant, failure === 'declined');
      assert.equal(response.status, 302);
      const error = new URL(response.headers.get('location')!, f.config.origin).searchParams.get('error');
      assert.ok(error);
      assert.doesNotMatch(error, /private-upstream-detail|private-shared-app-secret|consent-code/);
      for (const account of ['linkedin', 'linkedin-ads', 'facebook'] as const) f.assertUnchanged(account);
      assert.equal(f.upstreamRequests.length, 0, 'failed consent or token exchange must not read or write provider resources');
    });
  }
}
