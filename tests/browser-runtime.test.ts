import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { chromium, type Page } from 'playwright-core';
import { browserEnvironment, browserExecutableCandidates, LocalBrowserDriver } from '../server/browser-runtime';
import type { BrowserCredential } from '../server/browser-types';

const executable = browserExecutableCandidates('auto').find(candidate => existsSync(candidate.path))?.path;
const browserTest = { skip: !executable ? 'No installed Chrome, Edge, or Chromium for isolated headless runtime checks.' : false };
const origin = 'https://example.com';
const credential: BrowserCredential = { origins: [origin], username: 'owner@example.com', password: 'synthetic-Vault-Password-37!' };
const guard = () => {};
const login = '<title>Sign in</title><h1>Welcome</h1><form action="/session" method="post"><label>Email<input type="email" autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>';

async function fixture(html: string, run: (driver: LocalBrowserDriver, page: Page) => Promise<void>) {
  const browser = await chromium.launch({ executablePath: executable, headless: true, env: browserEnvironment() });
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  const page = await context.newPage();
  const driver = new LocalBrowserDriver(browser, context, page, async () => {});
  try { await driver.navigate(origin, guard); await run(driver, page); }
  finally { await driver.close(); }
}

test('browser discovery uses fixed native installation paths and strips sensitive environment values', () => {
  const candidates = browserExecutableCandidates('edge', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: '\\\\server\\share', PATH: '.;C:\\attacker' }, 'win32');
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(candidate => candidate.path.endsWith('Microsoft\\Edge\\Application\\msedge.exe')));
  assert.ok(candidates.every(candidate => !candidate.path.includes('attacker') && !candidate.path.startsWith('\\\\')));
  assert.deepEqual(browserEnvironment({ HOME: '/home/test', PATH: '/usr/bin', DISPLAY: ':1', CONNECTOR_API_KEY: 'secret', OP_SESSION_test: 'session', OP_SERVICE_ACCOUNT_TOKEN: 'secret', HTTPS_PROXY: 'untrusted', NODE_OPTIONS: '--inspect' }), { HOME: '/home/test', PATH: '/usr/bin', DISPLAY: ':1' });
});

test('browser snapshots omit all field values, URLs, and credential form text', browserTest, async () => {
  await fixture(`${login}<textarea>Private draft</textarea><input type="search" placeholder="Search" value="Private input"><a href="https://example.com/private?token=secret">Public link</a>`, async (driver, page) => {
    await page.locator('input[type=password]').fill('Existing manual password');
    const snapshot = await driver.snapshot(guard);
    assert.equal(snapshot.origin, origin);
    assert.equal(snapshot.title, 'Sign in');
    assert.match(snapshot.text, /Welcome/);
    assert.ok(snapshot.elements.some(element => element.role === 'password'));
    assert.ok(snapshot.elements.some(element => element.name === 'Public link'));
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ['Existing manual password', 'Private draft', 'Private input', '?token=', '/private', '<input', 'action=']) assert.ok(!serialized.includes(forbidden));
    assert.ok(snapshot.elements.every(element => /^[a-z0-9-]{36}$/.test(element.ref)));
  });
});

test('browser fills live credentials without submitting or returning their values', browserTest, async () => {
  await fixture(login, async (driver, page) => {
    await page.evaluate(() => { document.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); document.title = 'Submitted'; }); });
    assert.deepEqual(await driver.fillLogin(origin, credential, guard), { filled: 'username_and_password' });
    assert.equal(await page.locator('input[type=email]').inputValue(), credential.username);
    assert.equal(await page.locator('input[type=password]').inputValue(), credential.password);
    assert.equal(await page.title(), 'Sign in');
    await page.evaluate(({ username, password }) => {
      document.title = password;
      const paragraph = document.createElement('p'); paragraph.textContent = `${username} ${password}`; document.body.append(paragraph);
      const button = document.createElement('button'); button.textContent = password; document.body.append(button);
    }, credential);
    const serialized = JSON.stringify(await driver.snapshot(guard));
    assert.ok(!serialized.includes(credential.password));
    assert.ok(!serialized.includes(credential.username));
    assert.match(serialized, /\[redacted\]/);
  });
});

test('browser handles username-first sign-in and retrieves fields only from the top page', browserTest, async () => {
  await fixture('<form action="/next"><input type="email" autocomplete="username"><button>Next</button></form>', async (driver, page) => {
    assert.deepEqual(await driver.fillLogin(origin, credential, guard), { filled: 'username' });
    await page.evaluate(() => { document.body.innerHTML = '<form action="/session" method="post"><input type="password" autocomplete="current-password"><button>Sign in</button></form>'; });
    assert.deepEqual(await driver.fillLogin(origin, credential, guard), { filled: 'password' });
    await page.evaluate(() => { document.body.innerHTML = '<iframe srcdoc="<input type=password>"></iframe>'; });
    await assert.rejects(driver.fillLogin(origin, credential, guard), /could not identify one supported login form/);
  });
});

test('browser rejects mismatched origins, changed pages, cross-origin form actions and submit overrides', browserTest, async () => {
  await fixture(login, async (driver, page) => {
    await assert.rejects(driver.fillLogin(origin, { ...credential, origins: ['https://other.example.com'] }, guard), /does not match/);
    await assert.rejects(driver.fillLogin('https://other.example.com', { ...credential, origins: ['https://other.example.com'] }, guard), /website changed/);
    await page.locator('form').evaluate(form => form.setAttribute('action', 'https://other.example.com/session'));
    await assert.rejects(driver.fillLogin(origin, credential, guard), /another address/);
    assert.equal(await page.locator('input[type=password]').inputValue(), '');
    await page.locator('form').evaluate(form => form.setAttribute('action', '/session'));
    await page.locator('button').evaluate(button => button.setAttribute('formaction', 'https://other.example.com/session'));
    await assert.rejects(driver.fillLogin(origin, credential, guard), /another address/);
    assert.equal(await page.locator('input[type=password]').inputValue(), '');
  });
});

test('browser rejects password resets, ambiguous logins, and forms changed by username handlers', browserTest, async () => {
  await fixture(login, async (driver, page) => {
    await page.locator('input[type=password]').evaluate(input => input.setAttribute('autocomplete', 'new-password'));
    await assert.rejects(driver.fillLogin(origin, credential, guard), /could not identify/);
    await page.locator('input[type=password]').evaluate(input => input.setAttribute('autocomplete', 'current-password'));
    await page.locator('input[type=email]').evaluate(input => input.addEventListener('input', () => { document.querySelector('form')!.action = 'https://other.example.com/session'; }));
    await assert.rejects(driver.fillLogin(origin, credential, guard), /another address/);
    assert.equal(await page.locator('input[type=password]').inputValue(), '');
  });
});

test('browser rejects relative form actions resolved through an external base URL', browserTest, async () => {
  await fixture(`<base href="https://other.example.com/">${login}`, async (driver, page) => {
    await assert.rejects(driver.fillLogin(origin, credential, guard), /another address/);
    assert.equal(await page.locator('input[type=password]').inputValue(), '');
    await page.locator('form').evaluate(form => form.setAttribute('action', 'https://example.com/session'));
    await page.locator('button').evaluate(button => button.setAttribute('formaction', '/session'));
    await assert.rejects(driver.fillLogin(origin, credential, guard), /another address/);
    assert.equal(await page.locator('input[type=password]').inputValue(), '');
  });
});

test('browser rejects a password field changed into ordinary text while filling the username', browserTest, async () => {
  await fixture(login, async (driver, page) => {
    await page.locator('input[type=email]').evaluate(input => input.addEventListener('input', () => { document.querySelector<HTMLInputElement>('input[type=password]')!.type = 'text'; }));
    await assert.rejects(driver.fillLogin(origin, credential, guard), /changed during sign-in/);
    assert.equal(await page.locator('input[type=text]').inputValue(), '');
  });
});

test('browser typing rejects saved-login fields and requires fresh refs after an action', browserTest, async () => {
  await fixture(`${login}<input type="search" placeholder="Search"><button id="ordinary" onclick="document.title='Clicked'">Ordinary action</button>`, async (driver, page) => {
    let snapshot = await driver.snapshot(guard);
    const email = snapshot.elements.find(element => element.name === 'Email')!;
    await assert.rejects(driver.type(email.ref, 'agent-supplied-login', guard), /saved login fields/);
    const password = snapshot.elements.find(element => element.role === 'password')!;
    await assert.rejects(driver.type(password.ref, 'agent-supplied-password', guard), /saved login fields/);
    const search = snapshot.elements.find(element => element.name === 'Search')!;
    await driver.type(search.ref, 'ordinary search', guard);
    assert.equal(await page.locator('input[type=search]').inputValue(), 'ordinary search');
    await assert.rejects(driver.type(search.ref, 'stale', guard), /fresh browser snapshot/);
    snapshot = await driver.snapshot(guard);
    await driver.click(snapshot.elements.find(element => element.name === 'Ordinary action')!.ref, guard);
    assert.equal(await page.title(), 'Clicked');
  });
});

test('browser guards block a revoked action before credential filling', browserTest, async () => {
  await fixture(login, async (driver, page) => {
    await assert.rejects(driver.fillLogin(origin, credential, () => { throw new Error('access revoked'); }), /access revoked/);
    assert.equal(await page.locator('input[type=password]').inputValue(), '');
  });
});

test('browser redacts long and whitespace-containing secrets before truncating output', browserTest, async () => {
  const long = ' leading  spaced ' + 'X'.repeat(7900) + ' trailing ';
  await fixture(login, async (driver, page) => {
    await driver.fillLogin(origin, { ...credential, password: long }, guard);
    await page.evaluate(value => {
      const paragraph = document.createElement('p'); paragraph.textContent = 'a'.repeat(11_900) + value; document.body.append(paragraph);
      document.title = value;
    }, long);
    const snapshot = await driver.snapshot(guard);
    assert.ok(!snapshot.title.includes('leading'));
    assert.ok(!snapshot.text.includes('leading'));
    assert.ok(!snapshot.text.includes('XXXX'));
    assert.match(snapshot.title, /\[redacted\]/);
  });
});

test('browser rejects file upload and download controls and closes idempotently', browserTest, async () => {
  await fixture('<input type="file" aria-label="Upload"><a href="/download" download>Download</a>', async driver => {
    const snapshot = await driver.snapshot(guard);
    await assert.rejects(driver.click(snapshot.elements.find(element => element.name === 'Upload')!.ref, guard), /File selection/);
    await assert.rejects(driver.click(snapshot.elements.find(element => element.name === 'Download')!.ref, guard), /downloads/);
    await driver.close(); await driver.close();
    assert.equal(driver.origin(), '');
    await assert.rejects(driver.snapshot(guard), /closed/);
  });
});
