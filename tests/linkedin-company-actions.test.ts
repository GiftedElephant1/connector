import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { socialActions } from '../server/actions-social';
import { listActions, validateValues } from '../server/actions';
import { ProviderError } from '../server/provider-types';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'test-private-linkedin-token' };
const env = { LINKEDIN_ENABLE_ORGANIZATIONS: 'true', LINKEDIN_API_VERSION: '202601' };
const organizationUrn = 'urn:li:organization:123';
const postUrn = 'urn:li:share:456';

function action(id: string) {
  const adapter = socialActions.find(item => item.provider === 'linkedin' && item.definition.id === id);
  assert.ok(adapter, `LinkedIn ${id} must be registered`);
  return adapter;
}

function withCompanyDiscovery(respond: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>, roles = [{ organization: organizationUrn, role: 'ADMINISTRATOR', state: 'APPROVED' }]) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.linkedin.com');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-private-linkedin-token');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(init?.redirect, 'error');
    if (url.pathname === '/rest/organizationAcls') return Response.json({ elements: roles, paging: { start: 0, count: 100, total: roles.length } });
    if (url.pathname === '/rest/organizations/123') return Response.json({ id: 123, localizedName: 'Vectre Pay' });
    return respond(url, init);
  };
}

test('company actions expose explicit targets to the shared UI and AI action catalog, preserving member publishing', () => {
  const definitions = listActions('linkedin');
  const company = definitions.find(item => item.id === 'publish-organization');
  assert.ok(company);
  assert.equal(company.kind, 'write');
  assert.equal(company.schedulable, true);
  assert.equal(company.fields.find(field => field.name === 'organizationUrn')?.required, true);
  assert.equal(definitions.find(item => item.id === 'list-organizations')?.kind, 'read');
  assert.equal(definitions.find(item => item.id === 'organization-posts')?.kind, 'read');
  assert.deepEqual(validateValues(action('publish'), { text: 'Personal post' }), { text: 'Personal post' });
  assert.throws(() => validateValues(action('publish-organization'), { text: 'No target' }), /company Page URN is required/);
});

test('live company listing returns the company name and full organization identifier without credentials', async () => {
  withCompanyDiscovery(() => { throw new Error('No unrelated API request expected'); });
  const result = await action('list-organizations').execute(credential, {}, env);
  assert.deepEqual(result.items, [{ organizationUrn, name: 'Vectre Pay', type: 'organization' }]);
  assert.equal(JSON.stringify(result).includes(credential.accessToken), false);
});

test('company publishing rechecks access and uses the selected organization as author without reading a member profile', async () => {
  let posts = 0;
  withCompanyDiscovery((url, init) => {
    assert.equal(url.pathname, '/rest/posts');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('LinkedIn-Version'), env.LINKEDIN_API_VERSION);
    assert.equal(new Headers(init?.headers).get('X-Restli-Protocol-Version'), '2.0.0');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      author: organizationUrn, commentary: 'Company announcement', visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    });
    posts++;
    return new Response(null, { status: 201, headers: { 'x-restli-id': postUrn } });
  });
  const result = await action('publish-organization').execute(credential, { organizationUrn, text: 'Company announcement' }, env);
  assert.equal(posts, 1);
  assert.deepEqual(result.items, [{ id: postUrn, organizationUrn }]);
});

test('company actions reject absent, personal, malformed and unauthorized targets without a write', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Invalid identifiers must fail locally'); };
  for (const target of ['', 'urn:li:person:123', '123', 'urn:li:organization:123/../456']) {
    await assert.rejects(action('publish-organization').execute(credential, { organizationUrn: target, text: 'Hello' }, env), ProviderError);
  }
  assert.equal(calls, 0);
  withCompanyDiscovery(() => { throw new Error('Unauthorized company must never be used'); });
  await assert.rejects(action('publish-organization').execute(credential, { organizationUrn: 'urn:li:organization:999', text: 'Hello' }, env), /not available to the connected member/);
});

test('revoked or non-publishing company roles never fall back to personal publishing', async () => {
  for (const role of [{ organization: organizationUrn, role: 'ADMINISTRATOR', state: 'REVOKED' }, { organization: organizationUrn, role: 'ANALYST', state: 'APPROVED' }]) {
    withCompanyDiscovery(() => { throw new Error('No write is allowed for this role'); }, [role]);
    await assert.rejects(action('publish-organization').execute(credential, { organizationUrn, text: 'Hello' }, env), /not available to the connected member/);
  }
});

test('company posts are requested by organization author and returned with destination identifiers', async () => {
  withCompanyDiscovery((url, init) => {
    assert.equal(url.pathname, '/rest/posts');
    assert.equal(url.searchParams.get('q'), 'author');
    assert.equal(url.searchParams.get('author'), organizationUrn);
    assert.equal(url.searchParams.get('count'), '25');
    assert.equal(init?.method, undefined);
    return Response.json({ elements: [{ id: postUrn, author: organizationUrn, commentary: 'Company announcement', lifecycleState: 'PUBLISHED', createdAt: 1234, lastModifiedAt: 5678 }] });
  });
  const result = await action('organization-posts').execute(credential, { organizationUrn }, env);
  assert.deepEqual(result.items, [{ postUrn, organizationUrn, text: 'Company announcement', createdAt: '1234', lastModifiedAt: '5678', status: 'PUBLISHED' }]);
});

test('company post reads fail closed if the provider returns a different author', async () => {
  withCompanyDiscovery(() => Response.json({ elements: [{ id: postUrn, author: 'urn:li:person:456', commentary: 'Unrelated content' }] }));
  await assert.rejects(action('organization-posts').execute(credential, { organizationUrn }, env), /outside the selected company Page/);
});

test('company publication must return a created resource ID and never reveals provider error bodies', async () => {
  withCompanyDiscovery(() => Response.json({}));
  await assert.rejects(action('publish-organization').execute(credential, { organizationUrn, text: 'Hello' }, env), /did not confirm/);
  withCompanyDiscovery(() => Response.json({ message: credential.accessToken }, { status: 403 }));
  await assert.rejects(action('publish-organization').execute(credential, { organizationUrn, text: 'Hello' }, env), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.message.includes(credential.accessToken), false);
    return true;
  });
});
