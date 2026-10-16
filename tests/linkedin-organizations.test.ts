import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { linkedInOrganizationScopes, listLinkedInOrganizations } from '../server/linkedin-organizations.ts';
import { socialAdapters } from '../server/providers-social.ts';
import { ProviderError } from '../server/provider-types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const linkedin = socialAdapters.find((adapter) => adapter.definition.id === 'linkedin')!;
const env = { LINKEDIN_CLIENT_ID: 'client', LINKEDIN_ENABLE_ORGANIZATIONS: 'true', LINKEDIN_API_VERSION: '202609' };
const credential = { accessToken: 'private-token', fields: { scope: `openid profile w_member_social ${linkedInOrganizationScopes.join(' ')}` } };
const approved = (id: string, role = 'ADMINISTRATOR') => ({ organization: `urn:li:organization:${id}`, role, state: 'APPROVED' });

test('LinkedIn company permissions are opt-in and preserve existing member scopes', () => {
  const request = { env: { LINKEDIN_CLIENT_ID: 'client' }, redirectUri: 'https://connector.example/callback', state: 'state', codeVerifier: 'verifier' };
  assert.equal(new URL(linkedin.authorize!(request)).searchParams.get('scope'), 'openid profile w_member_social');
  const enabled = new URL(linkedin.authorize!({ ...request, env: { ...env, LINKEDIN_ENABLE_MEMBER_READ: 'true' } }));
  assert.equal(enabled.searchParams.get('scope'), `openid profile w_member_social r_member_social ${linkedInOrganizationScopes.join(' ')}`);
});

test('LinkedIn company discovery rejects disabled setup and missing returned scopes before requesting', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  await assert.rejects(listLinkedInOrganizations(credential, {}), /Enable LinkedIn company Pages/);
  for (const missing of linkedInOrganizationScopes) {
    await assert.rejects(listLinkedInOrganizations({ ...credential, fields: { scope: linkedInOrganizationScopes.filter((scope) => scope !== missing).join(',') } }, env), /permissions.*reconnect LinkedIn/);
  }
  await assert.rejects(listLinkedInOrganizations(credential, { ...env, LINKEDIN_API_VERSION: 'bad\r\nheader' }), /YYYYMM/);
  assert.equal(calls, 0);
});

test('LinkedIn discovery paginates ACLs, deduplicates and filters pending or non-publishing roles', async () => {
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    assert.equal(url.origin, 'https://api.linkedin.com');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer private-token');
    assert.equal(headers.get('LinkedIn-Version'), '202609');
    assert.equal(headers.get('X-Restli-Protocol-Version'), '2.0.0');
    if (url.pathname === '/rest/organizationAcls') {
      assert.equal(url.searchParams.get('q'), 'roleAssignee');
      assert.equal(url.searchParams.get('state'), 'APPROVED');
      assert.equal(url.searchParams.get('count'), '100');
      if (url.searchParams.get('start') === '0') return Response.json({
        elements: [approved('123'), { ...approved('999'), state: 'REQUESTED' }, approved('888', 'ANALYST'), approved('777', 'DIRECT_SPONSORED_CONTENT_POSTER')],
        paging: { start: 0, count: 4, links: [{ rel: 'next', href: 'https://attacker.example/steal?start=4' }] },
      });
      assert.equal(url.searchParams.get('start'), '4');
      return Response.json({
        elements: [approved('123'), { organizationTarget: 'urn:li:organization:456', role: 'CONTENT_ADMINISTRATOR', state: 'APPROVED' }, approved('nope'), approved('../escape')],
        paging: { start: 4, count: 4, links: [] },
      });
    }
    if (url.pathname === '/rest/organizations/123') return Response.json({ id: 123, localizedName: 'Vectre Pay' });
    assert.equal(url.pathname, '/rest/organizations/456');
    return Response.json({ id: 456, name: { localized: { fr_FR: 'Entreprise', en_US: 'Second Page' }, preferredLocale: { country: 'US', language: 'en' } } });
  };
  assert.deepEqual(await listLinkedInOrganizations(credential, env), [
    { id: 'urn:li:organization:123', name: 'Vectre Pay', type: 'organization' },
    { id: 'urn:li:organization:456', name: 'Second Page', type: 'organization' },
  ]);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((url) => !url.includes('private-token')));
});

test('LinkedIn can inspect older credentials without returned scopes and uses bounded count pagination', async () => {
  const starts: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    starts.push(url.searchParams.get('start')!);
    return Response.json({ elements: starts.length === 1 ? [approved('1', 'ANALYST')] : [], paging: { count: 1, total: 2 } });
  };
  assert.deepEqual(await listLinkedInOrganizations({ accessToken: 'token' }, env), []);
  assert.deepEqual(starts, ['0', '1']);
});

test('LinkedIn verification retains the authorizing member and appends company Pages', async () => {
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v2/userinfo') return Response.json({ sub: 'member-id', name: 'A.J. Denham' });
    if (path === '/rest/organizationAcls') return Response.json({ elements: [approved('123')] });
    assert.equal(path, '/rest/organizations/123');
    return Response.json({ id: 123, localizedName: 'Vectre Pay' });
  };
  assert.deepEqual(await linkedin.verify(credential, env), {
    accountId: 'member-id', accountName: 'A.J. Denham', resources: [
      { id: 'member-id', name: 'A.J. Denham', type: 'profile' },
      { id: 'urn:li:organization:123', name: 'Vectre Pay', type: 'organization' },
    ],
  });
});

test('Enabled LinkedIn company verification does not silently succeed with only a personal profile', async () => {
  globalThis.fetch = async (input) => new URL(String(input)).pathname === '/v2/userinfo'
    ? Response.json({ sub: 'member-id', name: 'A.J. Denham' })
    : Response.json({ elements: [approved('123', 'ANALYST'), { ...approved('456'), state: 'REQUESTED' }] });
  await assert.rejects(linkedin.verify(credential, env), /No manageable LinkedIn company Pages.*super admin or content admin/);
});

test('LinkedIn company discovery explains HTTP failures without exposing provider messages or tokens', async () => {
  for (const [status, expected] of [[401, /expired or was rejected/], [403, /approved organization permissions/], [429, /rate limiting/], [400, /HTTP 400/]] as const) {
    globalThis.fetch = async () => Response.json({ message: 'private-token upstream-private-message', status }, { status });
    await assert.rejects(listLinkedInOrganizations(credential, env), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, status === 400 ? 502 : status);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-token|upstream-private-message/);
      return true;
    });
  }
});

test('LinkedIn company discovery never hides a denied organization lookup', async () => {
  globalThis.fetch = async (input) => new URL(String(input)).pathname === '/rest/organizationAcls'
    ? Response.json({ elements: [approved('123')] })
    : Response.json({ message: 'private-token' }, { status: 403 });
  await assert.rejects(listLinkedInOrganizations(credential, env), /LinkedIn denied company Page access/);
});

test('LinkedIn malformed ACL responses and empty next pages fail instead of returning partial resources', async () => {
  for (const body of [{}, { elements: [null] }, { elements: [], paging: { links: [{ rel: 'next' }] } }]) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(listLinkedInOrganizations(credential, env), ProviderError);
  }
});

test('LinkedIn uses paging total when next links are empty and discovers more than 100 ACLs', async () => {
  const starts: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/organizationAcls') {
      const start = url.searchParams.get('start')!;
      starts.push(start);
      return Response.json({
        elements: start === '0' ? Array.from({ length: 100 }, (_, index) => approved(String(index + 1), 'ANALYST')) : [approved('321', 'CONTENT_ADMIN')],
        paging: { start: Number(start), count: 100, total: 101, links: [] },
      });
    }
    assert.equal(url.pathname, '/rest/organizations/321');
    return Response.json({ id: '321', localizedName: 'Vectre Pay' });
  };
  assert.deepEqual(await listLinkedInOrganizations(credential, env), [{ id: 'urn:li:organization:321', name: 'Vectre Pay', type: 'organization' }]);
  assert.deepEqual(starts, ['0', '100']);
});

test('LinkedIn rejects missing, mismatched and malformed organization lookup identities', async () => {
  for (const body of [{}, { localizedName: 'Vectre Pay' }, { id: 999, localizedName: 'Wrong Page' }, { id: '123/../456' }, { id: null }, { id: Number.MAX_SAFE_INTEGER + 1 }]) {
    globalThis.fetch = async (input) => new URL(String(input)).pathname === '/rest/organizationAcls'
      ? Response.json({ elements: [approved('123')] })
      : Response.json(body);
    await assert.rejects(listLinkedInOrganizations(credential, env), /invalid company Page identity/);
  }
});
