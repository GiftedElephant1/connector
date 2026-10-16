import assert from 'node:assert/strict';
import { test } from 'node:test';
import { socialAdapters } from '../server/providers-social.ts';
import { adsAdapters } from '../server/providers-ads.ts';
import { linkedInScopes, linkedInScopeOptions } from '../server/linkedin-scopes.ts';

const social = socialAdapters.find(adapter => adapter.definition.id === 'linkedin')!;
const ads = adsAdapters.find(adapter => adapter.definition.id === 'linkedin-ads')!;
const settings = { LINKEDIN_CLIENT_ID: 'shared-public-client', LINKEDIN_CLIENT_SECRET: 'private-secret' };
const url = (advertising: boolean, env: NodeJS.ProcessEnv) => new URL((advertising ? ads : social).authorize!({
  env, state: 'unique-oauth-state', codeVerifier: 'test-code-verifier', redirectUri: `https://connector.example/api/oauth/${advertising ? 'linkedin-ads' : 'linkedin'}/callback`,
}));

test('LinkedIn keeps social-only and advertising-only permissions unchanged unless combined access is explicitly enabled', () => {
  for (const combined of [undefined, '', 'false', 'TRUE']) {
    const env = { ...settings, LINKEDIN_COMBINE_SCOPES: combined };
    assert.equal(url(false, env).searchParams.get('scope'), 'openid profile w_member_social');
    assert.equal(url(true, env).searchParams.get('scope'), 'r_ads rw_ads r_ads_reporting');
  }
  assert.equal(url(false, { ...settings, LINKEDIN_ENABLE_CONVERSIONS: 'true' }).searchParams.get('scope'), 'openid profile w_member_social');
  assert.equal(url(true, { ...settings, LINKEDIN_ENABLE_ORGANIZATIONS: 'true', LINKEDIN_ENABLE_MEMBER_READ: 'true' }).searchParams.get('scope'), 'r_ads rw_ads r_ads_reporting');
});

test('both LinkedIn OAuth requests use identical approved scope sets for every combined option combination', () => {
  for (let mask = 0; mask < 8; mask++) {
    const env = {
      ...settings, LINKEDIN_COMBINE_SCOPES: 'true',
      LINKEDIN_ENABLE_MEMBER_READ: String(!!(mask & 1)),
      LINKEDIN_ENABLE_ORGANIZATIONS: String(!!(mask & 2)),
      LINKEDIN_ENABLE_CONVERSIONS: String(!!(mask & 4)),
    };
    const organic = url(false, env);
    const advertising = url(true, env);
    const expected = ['openid', 'profile', 'w_member_social',
      ...(mask & 1 ? ['r_member_social'] : []),
      ...(mask & 2 ? ['rw_organization_admin', 'r_organization_social', 'w_organization_social'] : []),
      'r_ads', 'rw_ads', 'r_ads_reporting', ...(mask & 4 ? ['rw_conversions'] : [])].join(' ');
    for (const request of [organic, advertising]) {
      assert.equal(request.origin + request.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
      assert.equal(request.searchParams.get('scope'), expected);
      assert.equal(request.searchParams.get('client_id'), settings.LINKEDIN_CLIENT_ID);
      assert.equal(request.searchParams.get('state'), 'unique-oauth-state');
      assert.equal(request.searchParams.has('client_secret'), false);
    }
    assert.equal(organic.searchParams.get('redirect_uri'), 'https://connector.example/api/oauth/linkedin/callback');
    assert.equal(advertising.searchParams.get('redirect_uri'), 'https://connector.example/api/oauth/linkedin-ads/callback');
    assert.equal(linkedInScopes(false, linkedInScopeOptions(env)).join(' '), expected);
    assert.equal(linkedInScopes(true, linkedInScopeOptions(env)).join(' '), expected);
  }
});
