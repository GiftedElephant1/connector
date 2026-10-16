import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import type { ActionDefinition } from '../server/action-types.ts';
import { Store, type Connection } from '../server/store.ts';

const memberScopes = 'openid profile w_member_social';
const companyScopes = 'rw_organization_admin r_organization_social w_organization_social';
const organization = { id: 'urn:li:organization:123', name: 'Vectre Pay', type: 'organization' };
const member = { id: 'member-123', name: 'A.J. Denham', type: 'profile' };

async function fixture(t: TestContext) {
  const config: AppConfig = {
    origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000,
    password: 'integration-owner-password', encryptionKey: Buffer.alloc(32, 37),
    databasePath: ':memory:', secureCookies: false, pipelineKey: 'integration-pipeline-key-'.repeat(3),
  };
  const env = { LINKEDIN_CLIENT_ID: 'integration-linkedin-app', LINKEDIN_CLIENT_SECRET: 'integration-linkedin-secret' };
  const store = new Store(':memory:', config.encryptionKey);
  const app = createApp(config, store, undefined, env);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = `connector_session=${store.createSession()}`;
  // Keep real local HTTP traffic separate from the mocked upstream provider fetch.
  const request = (path: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest(`${base}${path}`, { method: init.method, headers: init.headers as Record<string, string> }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value) {
          for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
        }
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
      });
    });
    outgoing.once('error', reject);
    if (typeof init.body === 'string') outgoing.write(init.body);
    outgoing.end();
  });
  const ownerMutation = (path: string, body: unknown, method = 'POST') => request(path, {
    method, headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify(body),
  });
  const aiHeaders = { authorization: `Bearer ${config.pipelineKey}`, 'content-type': 'application/json' };
  const previousCredential = { accessToken: 'old-member-token', fields: { scope: memberScopes } };
  const previous = store.save('linkedin', previousCredential, { accountId: member.id, accountName: member.name, resources: [member] });
  const facebookCredential = { accessToken: 'working-facebook-token' };
  const facebook = store.save('facebook', facebookCredential, {
    accountId: 'facebook-user', accountName: member.name,
    resources: [{ id: 'facebook-page-123', name: 'Vectre Pay', type: 'page' }],
  });
  const enableCompanyAccess = async () => {
    const saved = await ownerMutation('/api/settings', {
      values: { LINKEDIN_ENABLE_ORGANIZATIONS: 'true', LINKEDIN_API_VERSION: '202609' },
    }, 'PUT');
    assert.equal(saved.status, 200);
    assert.deepEqual(store.connection('linkedin'), previous, 'changing requested permissions must preserve the existing connection');
  };
  const start = async () => {
    const response = await ownerMutation('/api/oauth/linkedin/start', {});
    assert.equal(response.status, 200);
    const url = new URL((await response.json() as { url: string }).url);
    assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
    assert.equal(url.searchParams.get('client_id'), env.LINKEDIN_CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), `${config.origin}/api/oauth/linkedin/callback`);
    assert.equal(url.searchParams.get('scope'), `${memberScopes} ${companyScopes}`);
    assert.equal(url.searchParams.has('client_secret'), false);
    assert.ok(url.searchParams.get('state'));
    return url.searchParams.get('state')!;
  };
  const assertFacebookUnchanged = () => {
    assert.deepEqual(store.connection('facebook'), facebook);
    assert.deepEqual(store.credential('facebook'), facebookCredential);
  };
  return { config, env, store, cookie, request, ownerMutation, aiHeaders, previous, previousCredential, enableCompanyAccess, start, assertFacebookUnchanged };
}

test('saved LinkedIn company setup flows through OAuth, resource storage and Grok REST discovery without changing Facebook', async t => {
  const f = await fixture(t);
  await f.enableCompanyAccess();
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.origin === 'https://www.linkedin.com') {
      assert.equal(url.pathname, '/oauth/v2/accessToken');
      assert.equal(init?.method, 'POST');
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_id'), f.env.LINKEDIN_CLIENT_ID);
      assert.equal(body.get('client_secret'), f.env.LINKEDIN_CLIENT_SECRET);
      assert.equal(body.get('redirect_uri'), `${f.config.origin}/api/oauth/linkedin/callback`);
      assert.equal(body.get('code'), 'new-company-consent-code');
      return Response.json({ access_token: 'new-company-token', expires_in: 3600, scope: `${memberScopes} ${companyScopes}` });
    }
    assert.equal(url.origin, 'https://api.linkedin.com');
    assert.equal(init?.method, undefined, 'company discovery must perform no upstream write');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer new-company-token');
    if (url.pathname === '/v2/userinfo') return Response.json({ sub: member.id, name: member.name });
    assert.equal(new Headers(init?.headers).get('LinkedIn-Version'), '202609');
    if (url.pathname === '/rest/organizationAcls') return Response.json({
      elements: [{ organization: organization.id, role: 'ADMINISTRATOR', state: 'APPROVED' }],
    });
    assert.equal(url.pathname, '/rest/organizations/123');
    return Response.json({ id: 123, localizedName: organization.name });
  });
  const state = await f.start();
  const callback = await f.request(`/api/oauth/linkedin/callback?state=${state}&code=new-company-consent-code`, { headers: { cookie: f.cookie } });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/?connected=linkedin');
  assert.equal(f.store.credential('linkedin')?.accessToken, 'new-company-token');
  assert.deepEqual(f.store.connection('linkedin')?.resources, [member, organization]);
  assert.equal(f.store.connection('linkedin')?.accountName, member.name, 'authorizing member remains distinct from available company destinations');

  const dashboard = await f.request('/api/providers', { headers: { cookie: f.cookie } });
  assert.equal(dashboard.status, 200);
  const dashboardData = await dashboard.json() as { providers: { id: string; connection: Connection }[] };
  assert.deepEqual(dashboardData.providers.find(provider => provider.id === 'linkedin')?.connection.resources, [member, organization]);

  const connections = await f.request('/api/v1/connections', { headers: f.aiHeaders });
  assert.equal(connections.status, 200);
  const connectionText = await connections.text();
  const connectionData = JSON.parse(connectionText) as { connections: { provider: string; accountName: string; resources: typeof organization[]; actions: { id: string }[] }[] };
  const linkedIn = connectionData.connections.find(connection => connection.provider === 'linkedin')!;
  assert.equal(linkedIn.accountName, member.name);
  assert.deepEqual(linkedIn.resources, [member, organization]);
  assert.ok(linkedIn.actions.some(action => action.id === 'list-organizations'));
  assert.ok(linkedIn.actions.some(action => action.id === 'publish-organization'));

  const catalogResponse = await f.request('/api/v1/actions/linkedin', { headers: f.aiHeaders });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json() as { actions: ActionDefinition[] };
  assert.equal(catalog.actions.find(action => action.id === 'list-organizations')?.kind, 'read');
  const companyPublish = catalog.actions.find(action => action.id === 'publish-organization')!;
  assert.equal(companyPublish.kind, 'write');
  assert.equal(companyPublish.fields.find(field => field.name === 'organizationUrn')?.required, true);

  const listing = await f.request('/api/v1/actions/linkedin/list-organizations', {
    method: 'POST', headers: f.aiHeaders, body: JSON.stringify({ values: {} }),
  });
  assert.equal(listing.status, 200);
  const listingText = await listing.text();
  assert.deepEqual(JSON.parse(listingText).result.items, [{ organizationUrn: organization.id, name: organization.name, type: 'organization' }]);
  for (const secret of [f.env.LINKEDIN_CLIENT_SECRET, 'new-company-token', 'old-member-token', 'working-facebook-token']) {
    assert.equal(connectionText.includes(secret), false);
    assert.equal(listingText.includes(secret), false);
  }
  assert.deepEqual(requests, ['/oauth/v2/accessToken', '/v2/userinfo', '/rest/organizationAcls', '/rest/organizations/123', '/rest/organizationAcls', '/rest/organizations/123']);
  assert.equal(f.store.jobs().length, 0, 'read-only company discovery must not create publishing jobs');
  f.assertFacebookUnchanged();
});

for (const failure of ['consent-declined', 'missing-company-scope', 'page-access-denied'] as const) {
  test(`failed LinkedIn company reconnect (${failure}) preserves the stored personal connection and unrelated Facebook account`, async t => {
    const f = await fixture(t);
    await f.enableCompanyAccess();
    let upstreamCalls = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      upstreamCalls++;
      assert.notEqual(failure, 'consent-declined', 'declined consent must not exchange a code');
      const url = new URL(String(input));
      if (url.origin === 'https://www.linkedin.com') {
        assert.equal(url.pathname, '/oauth/v2/accessToken');
        return Response.json({ access_token: 'unverified-replacement-token', expires_in: 3600, scope: failure === 'missing-company-scope' ? memberScopes : `${memberScopes} ${companyScopes}` });
      }
      assert.equal(url.origin, 'https://api.linkedin.com');
      if (url.pathname === '/v2/userinfo') return Response.json({ sub: member.id, name: member.name });
      assert.equal(failure, 'page-access-denied');
      assert.equal(url.pathname, '/rest/organizationAcls');
      return Response.json({ message: 'unverified-replacement-token private-upstream-detail' }, { status: 403 });
    });
    const state = await f.start();
    const suffix = failure === 'consent-declined' ? 'error=access_denied' : 'code=failed-consent-code';
    const callback = await f.request(`/api/oauth/linkedin/callback?state=${state}&${suffix}`, { headers: { cookie: f.cookie } });
    assert.equal(callback.status, 302);
    const error = new URL(callback.headers.get('location')!, f.config.origin).searchParams.get('error');
    assert.ok(error);
    if (failure === 'missing-company-scope') assert.match(error, /required company Page permissions/);
    if (failure === 'page-access-denied') assert.match(error, /LinkedIn denied company Page access/);
    assert.doesNotMatch(error, /unverified-replacement-token|private-upstream-detail|failed-consent-code/);
    assert.equal(upstreamCalls, failure === 'consent-declined' ? 0 : failure === 'missing-company-scope' ? 2 : 3);
    assert.deepEqual(f.store.connection('linkedin'), f.previous);
    assert.deepEqual(f.store.credential('linkedin'), f.previousCredential);
    f.assertFacebookUnchanged();
  });
}
