import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { LegalPages } from '../server/legal.ts';
import { publicPageStyles, renderPublicPage } from '../server/public-pages.ts';
import { Store } from '../server/store.ts';

const template: AppConfig = {
  origin: 'https://connector.example', host: '127.0.0.1', port: 3000,
  password: 'owner-test-password', encryptionKey: Buffer.alloc(32, 6), databasePath: ':memory:', secureCookies: true,
};
function service(t: TestContext) {
  const config = { ...template };
  const store = new Store(':memory:', config.encryptionKey);
  t.after(() => store.close());
  return { config, store, legal: new LegalPages(config, store) };
}
async function fixture(t: TestContext) {
  const config = { ...template };
  const store = new Store(':memory:', config.encryptionKey);
  const app = createApp(config, store, undefined, {});
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init);
  const update = (body: unknown, cookie = '', headers: Record<string, string> = {}) => request('/api/legal', {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json', 'x-connector-request': '1', ...headers }, body: JSON.stringify(body),
  });
  const login = async () => {
    const result = await request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-connector-request': '1' }, body: JSON.stringify({ password: config.password }) });
    assert.equal(result.status, 200);
    return result.headers.get('set-cookie')!.split(';')[0];
  };
  return { config, store, request, update, login };
}

test('legal profile publishes the approved operator by default and incomplete saved profiles show a notice', t => {
  const { legal, store } = service(t);
  assert.deepEqual(legal.status(), {
    operatorName: 'Vectre Pay Inc', contactEmail: 'contact@vectrepay.com', updatedAt: '2026-10-13T22:35:46.000Z', configured: true, publicOrigin: template.origin,
    termsUrl: `${template.origin}/terms`, privacyUrl: `${template.origin}/privacy`, aboutUrl: `${template.origin}/about`, iconUrl: `${template.origin}/assets/connector-icon.png`,
  });
  for (const name of ['terms', 'privacy', 'about'] as const) {
    const page = legal.page(name);
    assert.equal(page.status, 200);
    assert.match(page.html, /Vectre Pay Inc/);
    assert.match(page.html, /contact@vectrepay\.com/);
  }
  // An explicitly saved profile always wins; never substitute defaults for a
  // missing field in that record or silently publish an incomplete policy.
  store.writeSetting('public-legal-profile-v1', { operatorName: '', contactEmail: '', updatedAt: null });
  assert.equal(legal.status().configured, false);
  for (const name of ['terms', 'privacy'] as const) {
    const page = legal.page(name);
    assert.equal(page.status, 503);
    assert.match(page.html, /Public policy setup is incomplete/);
    assert.doesNotMatch(page.html, /Effective date|mailto:|contact@vectrepay\.com|Your content and actions|Data processed/);
  }
  const about = legal.page('about');
  assert.equal(about.status, 200);
  assert.match(about.html, /self-hosted account integration app/);
  assert.match(about.html, /not a public service where visitors can create accounts/);
  assert.doesNotMatch(about.html, /contact@vectrepay\.com|mailto:/);
});

test('saving a valid profile publishes escaped contact details and a server-generated effective date', t => {
  const { legal } = service(t);
  const before = Date.now();
  const result = legal.save({ operatorName: '  A & B <Studio> "Owner"  ', contactEmail: 'privacy+connector@example.com' });
  assert.equal(result.configured, true);
  assert.equal(result.operatorName, 'A & B <Studio> "Owner"');
  assert.ok(Date.parse(result.updatedAt!) >= before && Date.parse(result.updatedAt!) <= Date.now());
  for (const name of ['terms', 'privacy', 'about'] as const) {
    const page = legal.page(name);
    assert.equal(page.status, 200);
    assert.match(page.html, /A &amp; B &lt;Studio&gt; &quot;Owner&quot;/);
    assert.doesNotMatch(page.html, /<Studio>|<script/i);
    assert.match(page.html, /mailto:privacy%2Bconnector%40example\.com/);
    assert.doesNotMatch(page.html, /setup is incomplete/);
  }
  assert.match(legal.page('terms').html, new RegExp(`datetime="${result.updatedAt!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('legal profile survives service recreation while URLs track the configured public origin', t => {
  const { legal, config, store } = service(t);
  const result = legal.save({ operatorName: 'Example Operator', contactEmail: 'privacy@example.com' });
  config.origin = 'https://new-public.example';
  const restored = new LegalPages(config, store).status();
  assert.equal(restored.operatorName, result.operatorName);
  assert.equal(restored.updatedAt, result.updatedAt);
  assert.equal(restored.termsUrl, 'https://new-public.example/terms');
  assert.equal(restored.privacyUrl, 'https://new-public.example/privacy');
  assert.equal(restored.aboutUrl, 'https://new-public.example/about');
  assert.equal(restored.iconUrl, 'https://new-public.example/assets/connector-icon.png');
});

test('contact email is encoded as a mailbox instead of mailto headers or HTML', t => {
  const { legal } = service(t);
  legal.save({ operatorName: 'Operator', contactEmail: 'privacy?subject=test@example.com' });
  const html = legal.page('privacy').html;
  assert.match(html, /href="mailto:privacy%3Fsubject%3Dtest%40example\.com"/);
  assert.doesNotMatch(html, /href="mailto:privacy\?/);
});

test('legal profile rejects invalid fields and partial updates without changing the saved notice', t => {
  const { legal } = service(t);
  const saved = legal.save({ operatorName: 'Example Operator', contactEmail: 'privacy@example.com' });
  for (const value of [
    undefined, null, [], 'owner', {}, { operatorName: 'Example' }, { operatorName: '', contactEmail: 'privacy@example.com' },
    { operatorName: 'A'.repeat(121), contactEmail: 'privacy@example.com' },
    { operatorName: 'Name\nHeader', contactEmail: 'privacy@example.com' },
    ...['', 'invalid', 'x@localhost', 'x@-example.com', 'x@example-.com', 'a..b@example.com', 'x@example.com\r\nBcc: a@evil.example', 'x@example.com?inject', 'x@@example.com', 'x@' + 'a'.repeat(64) + '.com'].map(contactEmail => ({ operatorName: 'Example', contactEmail })),
    { operatorName: 'Example', contactEmail: 'privacy@example.com', updatedAt: '2000-01-01' },
    { operatorName: 'Example', contactEmail: 'privacy@example.com', encryptionKey: 'new-secret' },
  ]) assert.throws(() => legal.save(value));
  assert.deepEqual(legal.status(), saved);
});

test('public legal pages work without sign-in, do not leak connected data and use CSP-compatible styles', async t => {
  const f = await fixture(t);
  f.store.save('private-fixture', { accessToken: 'never-expose-credential' }, { accountId: 'private-account-123', accountName: 'PRIVATE ACCOUNT NAME', resources: [] });
  f.store.writeSetting('fixture-secret', { secret: 'never-expose-setting' });
  f.store.createJob('private-job-456', 'fingerprint', 'private-fixture', 'post', { text: 'PRIVATE JOB CONTENT' }, Date.now());
  const initial = await f.request('/terms');
  assert.equal(initial.status, 200);
  assert.match(await initial.text(), /Vectre Pay Inc/);
  assert.equal(initial.headers.get('set-cookie'), null);
  const cookie = await f.login();
  assert.equal((await f.update({ operatorName: 'Public Owner', contactEmail: 'public@example.com' }, cookie)).status, 200);
  for (const path of ['/terms', '/privacy', '/about']) {
    const response = await f.request(path, { headers: { host: 'attacker.example' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.headers.get('content-security-policy')!, /style-src 'self'/);
    const html = await response.text();
    assert.match(html, /Public Owner/);
    assert.doesNotMatch(html, /never-expose|private-account-123|PRIVATE ACCOUNT NAME|private-job-456|PRIVATE JOB CONTENT|attacker\.example/);
    assert.doesNotMatch(html, /<script|<style|style=|onclick=/i);
    assert.match(html, /href="\/legal\/style\.css"/);
  }
  const css = await f.request('/legal/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type')!, /text\/css/);
  assert.match(await css.text(), /max-width:600px/);
});

test('owner legal settings require a session and existing app CSRF protections', async t => {
  const f = await fixture(t);
  const input = { operatorName: 'Owner', contactEmail: 'contact@example.com' };
  assert.equal((await f.request('/api/legal')).status, 401);
  assert.equal((await f.update(input)).status, 401);
  const cookie = await f.login();
  assert.equal((await f.request('/api/legal', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await f.update(input, cookie, { origin: 'https://attacker.example' })).status, 403);
  const saved = await f.update(input, cookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  const snapshot = await saved.json();
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.termsUrl, 'https://connector.example/terms');
  assert.deepEqual(await (await f.request('/api/legal', { headers: { cookie } })).json(), snapshot);
  const rejected = await f.update({ ...input, contactEmail: 'not-an-email' }, cookie);
  assert.equal(rejected.status, 400);
  assert.deepEqual(await (await f.request('/api/legal', { headers: { cookie } })).json(), snapshot);
});

test('privacy notice explains retention, plaintext metadata and independent service copies', t => {
  const { legal } = service(t);
  legal.save({ operatorName: 'Operator', contactEmail: 'privacy@example.com' });
  const html = legal.page('privacy').html;
  for (const text of [
    'no automatic job-history deletion schedule', 'not encrypted by the app', 'does not erase previous job records',
    'results already sent to the AI provider', 'local vault folder', 'Bank tools do not transfer funds', 'necessary sign-in session cookie',
    'delete its database and relevant backups', 'ngrok', 'bounded registration limit',
  ]) assert.ok(html.includes(text), text);
});

test('public site homepage explains real Google features and links directly to policies without requiring sign-in', () => {
  const profile = { operatorName: 'Public Operator', contactEmail: 'contact@example.com', configured: true, updatedAt: '2026-10-15T00:00:00.000Z' };
  const home = renderPublicPage('home', profile, { basePath: '/connector', canonicalOrigin: 'https://public.example' });
  assert.match(home, /href="https:\/\/public\.example\/connector\/"/);
  assert.match(home, /href="\/connector\/privacy"/);
  assert.match(home, /href="\/connector\/terms"/);
  assert.match(home, /href="\/connector\/privacy#google-data"/);
  assert.match(home, /href="\/connector\/legal\/style\.css"/);
  assert.match(home, /src="\/connector\/assets\/connector-icon\.png"/);
  assert.match(home, /mailto:contact%40example\.com/);
  assert.match(home, /selected YouTube channel/);
  assert.match(home, /each account/);
  assert.match(home, /not a public service where visitors can create accounts/);
  assert.doesNotMatch(home, />Owner sign-in<|<script|<style|style=|onclick=/i);
  assert.ok(publicPageStyles.includes('.feature-grid'));
  const privacy = renderPublicPage('privacy', profile, { basePath: '/connector', canonicalOrigin: 'https://public.example' });
  assert.match(privacy, /href="https:\/\/public\.example\/connector\/privacy"/);
  assert.match(privacy, /id="google-data"/);
  const app = renderPublicPage('about', profile, { homePath: '/about', ownerUrl: '/' });
  assert.match(app, /href="\/about" aria-current="page"/);
  assert.match(app, /href="\/">Owner sign-in/);
});

test('public Google disclosure describes limited use, AI transfers and revocation without claiming provider guarantees', t => {
  const { legal } = service(t);
  const html = legal.page('privacy').html;
  for (const text of [
    'Google API Limited Use commitments', 'Google API Services User Data Policy', 'Google Workspace API User Data and Developer Policy',
    'email or document text', 'train or improve generalized AI models', 'cannot independently inspect or enforce',
    'not a claim that Google has verified or approved', 'Google Account third-party connections', 'without a saved read-history record',
    'account settings and write receipts remain',
  ]) assert.ok(html.includes(text), text);
  assert.match(html, /href="https:\/\/myaccount\.google\.com\/connections"/);
});

test('public renderer rejects unsafe link configuration and escapes all supplied public profile data', () => {
  const profile = { operatorName: '<script>operator</script>', contactEmail: 'contact@example.com', configured: true, updatedAt: null };
  const html = renderPublicPage('home', profile);
  assert.match(html, /&lt;script&gt;operator&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/i);
  for (const basePath of ['//external.example', '/test?redirect=1', '/bad"name', '/bad\\path', '/../path']) assert.throws(() => renderPublicPage('home', profile, { basePath }));
  for (const ownerUrl of ['javascript:alert(1)', 'data:text/html,test', '//external.example', 'https://user:password@example.com']) assert.throws(() => renderPublicPage('home', profile, { ownerUrl }));
  for (const canonicalOrigin of ['http://example.com', 'https://example.com/path', 'https://example.com?query=1', 'https://user:password@example.com']) assert.throws(() => renderPublicPage('home', profile, { canonicalOrigin }));
});
