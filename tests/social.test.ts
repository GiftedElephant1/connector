import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { socialAdapters } from '../server/providers-social.ts';
import { ProviderError, type Credential } from '../server/provider-types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const env = {
  X_CLIENT_ID: 'x-client', X_CLIENT_SECRET: 'x-secret',
  TIKTOK_CLIENT_KEY: 'tiktok-client', TIKTOK_CLIENT_SECRET: 'tiktok-secret',
  LINKEDIN_CLIENT_ID: 'linkedin-client', LINKEDIN_CLIENT_SECRET: 'linkedin-secret',
  REDDIT_CLIENT_ID: 'reddit-client', REDDIT_CLIENT_SECRET: 'reddit-secret', REDDIT_USER_AGENT: 'web:connector-test:0.1 (by /u/test_user)',
  PINTEREST_CLIENT_ID: 'pinterest-client', PINTEREST_CLIENT_SECRET: 'pinterest-secret',
  WORDPRESS_CLIENT_ID: 'wordpress-client', WORDPRESS_CLIENT_SECRET: 'wordpress-secret',
};

function adapter(id: string) {
  const result = socialAdapters.find((item) => item.definition.id === id);
  assert.ok(result);
  return result;
}

test('social OAuth uses official authorization origins and only necessary permissions', () => {
  const cases = [
    ['x', 'https://x.com', 'tweet.read tweet.write users.read dm.read dm.write offline.access'],
    ['tiktok', 'https://www.tiktok.com', 'user.info.basic,video.publish,video.list'],
    ['linkedin', 'https://www.linkedin.com', 'openid profile w_member_social'],
    ['reddit', 'https://www.reddit.com', 'identity read submit privatemessages'],
    ['pinterest', 'https://www.pinterest.com', 'user_accounts:read,boards:read,boards:write,pins:read,pins:write'],
    ['wordpress', 'https://public-api.wordpress.com', null],
  ];
  for (const [id, origin, scope] of cases) {
    const request = { env, redirectUri: `https://connector.example/api/oauth/${id}/callback`, state: 'one-use-state', codeVerifier: 'verifier-one' };
    const url = new URL(adapter(id!).authorize!(request));
    assert.equal(url.origin, origin);
    assert.equal(url.searchParams.get('state'), request.state);
    assert.equal(url.searchParams.get('redirect_uri'), request.redirectUri);
    assert.equal(url.searchParams.get('scope'), scope);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.toString().includes('secret'), false);
    if (id === 'x') {
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(request.codeVerifier).digest('base64url'));
      assert.equal(url.searchParams.has('code_verifier'), false);
    }
    if (id === 'reddit') assert.equal(url.searchParams.get('duration'), 'permanent');
    if (id === 'tiktok') {
      assert.equal(url.searchParams.get('client_key'), env.TIKTOK_CLIENT_KEY);
      assert.equal(url.searchParams.has('client_id'), false);
    }
  }
});

test('authorization-code exchanges carry provider-specific authentication and never use query-string tokens', async () => {
  const endpointById: Record<string, string> = {
    x: 'https://api.x.com/2/oauth2/token',
    tiktok: 'https://open.tiktokapis.com/v2/oauth/token/',
    linkedin: 'https://www.linkedin.com/oauth/v2/accessToken',
    reddit: 'https://www.reddit.com/api/v1/access_token',
    pinterest: 'https://api.pinterest.com/v5/oauth/token',
    wordpress: 'https://public-api.wordpress.com/oauth2/token',
  };
  for (const current of socialAdapters) {
    const id = current.definition.id;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, endpointById[id]);
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      const form = new URLSearchParams(String(init?.body));
      const headers = new Headers(init?.headers);
      assert.equal(form.get('code'), 'one-use-code');
      assert.equal(form.get('redirect_uri'), `https://connector.example/api/oauth/${id}/callback`);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
      if (['x', 'reddit', 'pinterest'].includes(id)) {
        assert.equal(headers.get('authorization'), `Basic ${Buffer.from(`${id}-client:${id}-secret`).toString('base64')}`);
        assert.equal(form.has('client_secret'), false);
      } else {
        assert.equal(form.get('client_secret'), `${id}-secret`);
      }
      if (id === 'x') assert.equal(form.get('code_verifier'), 'verifier-one');
      if (id === 'tiktok') assert.equal(form.get('client_key'), env.TIKTOK_CLIENT_KEY);
      if (id === 'reddit') assert.equal(headers.get('user-agent'), env.REDDIT_USER_AGENT);
      if (id === 'pinterest') assert.equal(form.get('continuous_refresh'), 'true');
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'returned-scope', token_type: 'bearer' });
    };
    const credential = await current.exchange!({ env, redirectUri: `https://connector.example/api/oauth/${id}/callback`, code: 'one-use-code', codeVerifier: 'verifier-one' });
    assert.equal(credential.accessToken, 'access');
    assert.equal(credential.refreshToken, 'refresh');
    assert.equal(credential.fields?.scope, 'returned-scope');
    assert.ok(credential.expiresAt! > Date.now() + 3_590_000);
  }
});

const profiles = [
  { id: 'x', url: 'https://api.x.com/2/users/me', body: { data: { id: 'x-user', username: 'alice', name: 'Alice' } }, accountId: 'x-user', accountName: '@alice' },
  { id: 'tiktok', url: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', body: { data: { user: { open_id: 'tt-user', display_name: 'Alice' } }, error: { code: 'ok' } }, accountId: 'tt-user', accountName: 'Alice' },
  { id: 'linkedin', url: 'https://api.linkedin.com/v2/userinfo', body: { sub: 'li-user', name: 'Alice', email: 'private@example.org' }, accountId: 'li-user', accountName: 'Alice' },
  { id: 'reddit', url: 'https://oauth.reddit.com/api/v1/me', body: { id: 'r-user', name: 'alice', inbox_count: 123 }, accountId: 'r-user', accountName: 'u/alice' },
  { id: 'pinterest', url: 'https://api.pinterest.com/v5/user_account', body: { id: 'p-user', username: 'alice', business_name: 'Alice Business' }, accountId: 'p-user', accountName: 'Alice Business' },
];

for (const expected of profiles) {
  test(`${expected.id} requires a real read API response and normalizes the profile`, async () => {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, expected.url);
      assert.ok(!init?.method || init.method === 'GET');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
      assert.equal(init?.redirect, 'error');
      return Response.json(expected.body);
    };
    assert.deepEqual(await adapter(expected.id).verify({ accessToken: 'test-token' }, env), {
      accountId: expected.accountId, accountName: expected.accountName,
      resources: [{ id: expected.accountId, name: expected.accountName, type: 'profile' }],
    });
    globalThis.fetch = async () => Response.json({ error: 'credential-private-data' });
    await assert.rejects(adapter(expected.id).verify({ accessToken: 'test-token' }, env), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes('credential-private-data'), false);
      return true;
    });
  });
}

test('TikTok errors inside successful HTTP responses cannot mark accounts connected', async () => {
  globalThis.fetch = async () => Response.json({ data: { user: { open_id: 'id', display_name: 'Alice' } }, error: { code: 'access_token_invalid', message: 'private-token' } });
  await assert.rejects(adapter('tiktok').verify({ accessToken: 'test-token' }, env), /valid account/);
});

test('WordPress reads only fixed WordPress.com APIs and bounds the returned connected sites', async () => {
  const seen: string[] = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    assert.ok(!init?.method || init.method === 'GET');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
    if (String(url).endsWith('/me')) return Response.json({ ID: 42, display_name: 'Alice', email: 'private@example.org' });
    return Response.json({ sites: [null, 'bad', { ID: 0 }, ...Array.from({ length: 150 }, (_, i) => ({ ID: i + 1, name: `Site ${i}`, URL: 'http://127.0.0.1/private', private_value: 'omit' }))] });
  };
  const result = await adapter('wordpress').verify({ accessToken: 'test-token', fields: { url: 'http://127.0.0.1/' } }, env);
  assert.deepEqual(seen, ['https://public-api.wordpress.com/rest/v1.1/me', 'https://public-api.wordpress.com/rest/v1.1/me/sites']);
  assert.equal(result.accountId, '42');
  assert.equal(result.resources.length, 100);
  assert.deepEqual(result.resources[0], { id: '1', name: 'Site 0', type: 'site' });
  assert.equal(JSON.stringify(result).includes('private@example.org'), false);
  globalThis.fetch = async () => Response.json({ ID: 42, display_name: 'Alice' });
  await assert.rejects(adapter('wordpress').verify({ accessToken: 'test-token' }, env), /valid account/);
});

test('social token refresh preserves omitted refresh tokens and scopes, and persists rotated values', async () => {
  for (const current of socialAdapters.filter((item) => item.refresh)) {
    const previous: Credential = { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1, tokenType: 'bearer', fields: { scope: 'old-scope' } };
    globalThis.fetch = async (_url, init) => {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'old-refresh');
      return Response.json({ access_token: 'new', expires_in: 3600 });
    };
    const retained = await current.refresh!(previous, env);
    assert.equal(retained.refreshToken, 'old-refresh');
    assert.equal(retained.fields?.scope, 'old-scope');
    assert.equal(retained.tokenType, 'bearer');
    assert.ok(retained.expiresAt! > Date.now());
    globalThis.fetch = async () => Response.json({ access_token: 'new', refresh_token: 'new-refresh', scope: 'new-scope', refresh_token_expires_in: 86_400 });
    const rotated = await current.refresh!(previous, env);
    assert.equal(rotated.refreshToken, 'new-refresh');
    assert.equal(rotated.fields?.scope, 'new-scope');
    assert.ok(Number(rotated.fields?.refreshExpiresAt) > Date.now());
    assert.equal(rotated.expiresAt, undefined);
  }
});

test('empty, malformed, or error token responses cannot become usable credentials', async () => {
  for (const body of [{}, { access_token: '' }, { access_token: 'bad\r\nheader' }, { access_token: 'token', error: 'private-error' }]) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(adapter('tiktok').exchange!({ env, code: 'code', redirectUri: 'https://connector.example/callback', codeVerifier: 'verifier' }), ProviderError);
  }
});

test('invalid social credentials are rejected before any request', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({}); };
  for (const current of socialAdapters) {
    await assert.rejects(current.verify({ accessToken: 'invalid\nvalue' }, env), ProviderError);
  }
  assert.equal(requests, 0);
});
