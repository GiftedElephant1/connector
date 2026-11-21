import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Store } from '../server/store';
import { ProviderError } from '../server/provider-types';
import { ManagedBrowserService } from '../server/browser';
import type { BrowserCredential, BrowserDriver, BrowserLogin, BrowserPageSnapshot, BrowserRuntime, BrowserVault } from '../server/browser-types';

const secret = 'credential-that-must-stay-inside-connector';
const login: BrowserLogin = { accountId: 'a'.repeat(26), vaultId: 'b'.repeat(26), itemId: 'c'.repeat(26), title: 'Work account', accountName: 'Work', vaultName: 'Shared', origins: ['https://example.com'] };
const credential: BrowserCredential = { origins: ['https://example.com'], username: 'fixture-login-user', password: secret };
class FakeDriver implements BrowserDriver {
  current = ''; closed = 0; filled = 0; clicked = 0; typed = 0;
  content: BrowserPageSnapshot = { origin: 'https://example.com', title: 'Login', text: 'Please sign in', elements: [{ ref: 'e1', role: 'button', name: 'Sign in' }] };
  origin() { return this.current; }
  async navigate(url: string, guard: () => void) { guard(); this.current = new URL(url).origin; }
  async snapshot(guard: () => void) { guard(); return { ...this.content, privateValue: secret }; }
  async click(_ref: string, guard: () => void) { guard(); this.clicked++; }
  async type(_ref: string, _text: string, guard: () => void) { guard(); this.typed++; }
  async fillLogin(origin: string, value: BrowserCredential, guard: () => void) { guard(); assert.equal(origin, this.current); assert.equal(value.password, secret); this.filled++; return { filled: 'username_and_password' as const, privateValue: secret }; }
  async close() { this.closed++; }
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(t: TestContext, options: { vault?: Partial<BrowserVault>; runtime?: Partial<BrowserRuntime> } = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 41));
  let principals = [{ id: 'key:allowed', label: 'Shared Connector key' }, { id: 'oauth:other', label: 'Other AI' }];
  const password = { enabled: true, executable: '', revision: 'p1' };
  const drivers: FakeDriver[] = [];
  const vault: BrowserVault = { browserLogins: async (_executable, _origin, guard) => { guard?.(); return [login]; }, browserCredential: async () => credential, ...options.vault };
  const runtime: BrowserRuntime = { check: async () => ({ installed: true, name: 'Chrome', message: 'Ready.' }), launch: async () => { const driver = new FakeDriver(); drivers.push(driver); return driver; }, ...options.runtime };
  const browser = new ManagedBrowserService(store, () => principals, () => password, vault, runtime);
  t.after(async () => { await browser.close(); store.close(); });
  await browser.configure({ enabled: true, browser: 'auto', principals: principals.map(item => item.id) });
  const open = (principal = 'key:allowed', guard: () => void = () => {}) => browser.open({ url: 'https://example.com/login?ordinary=value', confirmed: true }, principal, guard);
  return { store, browser, password, drivers, vault, runtime, open, setPrincipals(value: typeof principals) { principals = value; } };
}

test('browser grants are separate, exact and do not transfer to new principals', async t => {
  const f = await fixture(t);
  assert.equal(f.browser.hasAccess('key:unknown'), false);
  await assert.rejects(f.open('key:unknown'), /not enabled/);
  await assert.rejects(f.browser.configure({ enabled: true, browser: 'auto', principals: ['key:unknown'] }), /current AI/);
  await assert.rejects(f.browser.configure({ enabled: true, browser: 'auto', principals: [], executable: '/bin/sh' }));
  const opened = await f.open();
  assert.equal(f.drivers.length, 1);
  assert.equal(f.browser.snapshot().sessions.length, 1);
  f.setPrincipals([{ id: 'key:replacement', label: 'New key' }]);
  assert.equal(f.browser.hasAccess('key:replacement'), false);
  assert.equal(f.browser.hasAccess('key:allowed'), false);
  await assert.rejects(f.browser.snapshotPage({ sessionId: opened.sessionId }, 'key:allowed'), /not enabled/);
});
test('browser session ownership and strict inputs are enforced for every action', async t => {
  const f = await fixture(t), opened = await f.open();
  for (const action of [
    () => f.browser.snapshotPage({ sessionId: opened.sessionId }, 'oauth:other'),
    () => f.browser.navigate({ sessionId: opened.sessionId, url: 'https://example.com', confirmed: true }, 'oauth:other'),
    () => f.browser.click({ sessionId: opened.sessionId, ref: 'e1', confirmed: true }, 'oauth:other'),
    () => f.browser.type({ sessionId: opened.sessionId, ref: 'e1', text: 'hello', confirmed: true }, 'oauth:other'),
    () => f.browser.signIn({ sessionId: opened.sessionId, confirmed: true }, 'oauth:other'),
    () => f.browser.closeSession({ sessionId: opened.sessionId }, 'oauth:other'),
  ]) await assert.rejects(action(), /not available/);
  await assert.rejects(f.browser.signIn({ sessionId: opened.sessionId, confirmed: true, vaultId: login.vaultId }, 'key:allowed'));
  await assert.rejects(f.browser.click({ sessionId: opened.sessionId, ref: 'e1' }, 'key:allowed'));
  await assert.rejects(f.browser.type({ sessionId: opened.sessionId, ref: 'e1', text: 'hello', confirmed: true, javascript: 'document.cookie' }, 'key:allowed'));
  assert.equal(f.drivers[0].filled, 0);
});
test('unique exact-origin matches are filled live with no credential in any response', async t => {
  const f = await fixture(t), opened = await f.open();
  const result = await f.browser.signIn({ sessionId: opened.sessionId, confirmed: true }, 'key:allowed');
  assert.deepEqual({ status: result.status, filled: result.status === 'filled' && result.filled }, { status: 'filled', filled: 'username_and_password' });
  assert.equal(f.drivers[0].filled, 1);
  assert.equal(f.drivers[0].clicked, 0);
  f.drivers[0].content = { origin: 'https://example.com', title: secret, text: `Hello ${credential.username}. ${secret}`, elements: [{ ref: 'e2', role: 'button', name: secret }] };
  const snapshot = await f.browser.snapshotPage({ sessionId: opened.sessionId }, 'key:allowed');
  const output = JSON.stringify({ result, snapshot, settings: f.browser.snapshot() });
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(credential.username), false);
  assert.equal(snapshot.text.includes('[redacted]'), true);
  assert.equal('privateValue' in snapshot, false);
});
test('several all-vault matches return scoped opaque choices instead of guessing a login', async t => {
  const matches = [login, { ...login, vaultId: 'd'.repeat(26), itemId: 'e'.repeat(26), vaultName: 'Another vault' }];
  const reads: unknown[] = [];
  const f = await fixture(t, { vault: { browserLogins: async () => matches, browserCredential: async (_executable, selection) => { reads.push(selection); return credential; } } });
  const opened = await f.open(), choices = await f.browser.signIn({ sessionId: opened.sessionId, confirmed: true }, 'key:allowed');
  assert.equal(choices.status, 'choose_login');
  if (choices.status !== 'choose_login') return;
  assert.equal(choices.logins.length, 2);
  assert.deepEqual(choices.logins.map(item => item.vault), ['Shared', 'Another vault']);
  assert.equal(JSON.stringify(choices).includes(login.itemId), false);
  assert.equal(f.drivers[0].filled, 0);
  const selected = choices.logins[1].loginId;
  await f.browser.signIn({ sessionId: opened.sessionId, loginId: selected, confirmed: true }, 'key:allowed');
  assert.deepEqual(reads, [{ accountId: login.accountId, vaultId: 'd'.repeat(26), itemId: 'e'.repeat(26) }]);
  await assert.rejects(f.browser.signIn({ sessionId: opened.sessionId, loginId: selected, confirmed: true }, 'key:allowed'), /expired/);
});
test('no match and changed source origins cannot autofill credentials', async t => {
  const f = await fixture(t, { vault: { browserLogins: async () => [] } }), opened = await f.open();
  assert.equal((await f.browser.signIn({ sessionId: opened.sessionId, confirmed: true }, 'key:allowed')).status, 'no_match');
  f.vault.browserLogins = async () => [login];
  f.vault.browserCredential = async () => ({ ...credential, origins: ['https://different.example'] });
  await assert.rejects(f.browser.signIn({ sessionId: opened.sessionId, confirmed: true }, 'key:allowed'), /does not match/);
  assert.equal(f.drivers[0].filled, 0);
});
for (const change of ['auth', 'disable', 'permissions', 'password-revision', 'password-disable', 'page-origin', 'close-all'] as const) {
  test(`${change} during a 1Password read prevents autofill`, async t => {
    const entered = deferred(), waiting = deferred();
    const f = await fixture(t, { vault: { browserCredential: async () => { entered.release(); await waiting.promise; return credential; } } });
    let authenticated = true;
    const guard = () => { if (!authenticated) throw new ProviderError('Authentication revoked.', 401); };
    const opened = await f.open('key:allowed', guard);
    const pending = f.browser.signIn({ sessionId: opened.sessionId, confirmed: true }, 'key:allowed', guard);
    await entered.promise;
    if (change === 'auth') authenticated = false;
    else if (change === 'disable') await f.browser.configure({ enabled: false, browser: 'auto', principals: ['key:allowed'] });
    else if (change === 'permissions') f.setPrincipals([]);
    else if (change === 'password-revision') f.password.revision = 'p2';
    else if (change === 'password-disable') f.password.enabled = false;
    else if (change === 'page-origin') f.drivers[0].current = 'https://different.example';
    else await f.browser.closeAll();
    waiting.release(); await assert.rejects(pending);
    assert.equal(f.drivers[0].filled, 0);
  });
}
test('session operations serialize while live credential approval is pending', async t => {
  const entered = deferred(), waiting = deferred();
  const f = await fixture(t, { vault: { browserCredential: async () => { entered.release(); await waiting.promise; return credential; } } });
  const opened = await f.open();
  const pending = f.browser.signIn({ sessionId: opened.sessionId, confirmed: true }, 'key:allowed');
  await entered.promise;
  await assert.rejects(f.browser.navigate({ sessionId: opened.sessionId, url: 'https://example.org', confirmed: true }, 'key:allowed'), /already working/);
  await assert.rejects(f.browser.snapshotPage({ sessionId: opened.sessionId }, 'key:allowed'), /already working/);
  waiting.release(); await pending;
  assert.equal(f.drivers[0].filled, 1);
});
test('closing all browsers during launch closes the late process without exposing a session', async t => {
  const entered = deferred(), waiting = deferred(), driver = new FakeDriver();
  const f = await fixture(t, { runtime: { launch: async () => { entered.release(); await waiting.promise; return driver; } } });
  const pending = f.open(); await entered.promise;
  await f.browser.closeAll(); waiting.release();
  await assert.rejects(pending, /access changed/);
  assert.equal(driver.closed, 1);
  assert.equal(f.browser.snapshot().sessions.length, 0);
});
test('opening twice reuses this principal’s isolated browser; idle sessions expire', async t => {
  const f = await fixture(t), first = await f.open(), second = await f.open();
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(f.drivers.length, 1);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 16 * 60_000);
  await assert.rejects(f.browser.snapshotPage({ sessionId: first.sessionId }, 'key:allowed'), /expired/);
  assert.equal(f.drivers[0].closed, 1);
});
test('closing the visible window permits a fresh session and stale permissions never prevent disabling', async t => {
  const f = await fixture(t), first = await f.open();
  f.drivers[0].current = '';
  const second = await f.open();
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(f.drivers[0].closed, 1);
  assert.equal(f.drivers.length, 2);
  f.setPrincipals([]);
  const disabled = await f.browser.configure({ enabled: false, browser: 'auto', principals: ['key:allowed'] });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.principals, []);
  assert.equal(f.drivers[1].closed, 1);
});
test('unknown browser failures never expose upstream bodies or credential values', async t => {
  const f = await fixture(t), opened = await f.open();
  f.drivers[0].snapshot = async () => { throw new Error(`browser failed with ${secret}`); };
  await assert.rejects(f.browser.snapshotPage({ sessionId: opened.sessionId }, 'key:allowed'), error => error instanceof ProviderError && error.status === 502 && !error.message.includes(secret));
});
