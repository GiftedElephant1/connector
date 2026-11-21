import { randomUUID } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Page } from 'playwright-core';
import type { BrowserChoice, BrowserCheck, BrowserCredential, BrowserDriver, BrowserPageSnapshot, BrowserRuntime } from './browser-types';
import { startBrowserProxy, validateBrowserUrl } from './browser-network';
import { ProviderError } from './provider-types';

const MISSING = 'Install Microsoft Edge or Google Chrome on the computer running Connector, then check the browser again.';
const OPERATION_FAILED = 'The browser could not complete this action. Check its window on the Connector computer, then request a fresh page snapshot.';
const STALE = 'This page element is no longer available. Request a fresh browser snapshot.';
const EMPTY = () => {};
const MAX_SECRET = 8192;
const MAX_REDACTIONS = 100;
const ELEMENT_SELECTOR = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="tab"]';

export function browserExecutableCandidates(choice: BrowserChoice, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { name: string; path: string }[] {
  const value = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1] || '';
  const candidates: { choice: BrowserChoice; name: string; path: string }[] = [];
  if (platform === 'win32') {
    for (const root of [value('ProgramFiles(x86)'), value('ProgramFiles'), value('LOCALAPPDATA')]) {
      if (!path.win32.isAbsolute(root) || root.startsWith('\\\\') || root.startsWith('//') || /[\u0000-\u001f\u007f]/.test(root)) continue;
      candidates.push({ choice: 'edge', name: 'Microsoft Edge', path: path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
      candidates.push({ choice: 'chrome', name: 'Google Chrome', path: path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    }
  } else if (platform === 'darwin') {
    candidates.push({ choice: 'edge', name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { choice: 'chrome', name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  } else {
    candidates.push({ choice: 'edge', name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
      { choice: 'chrome', name: 'Google Chrome', path: '/usr/bin/google-chrome' },
      { choice: 'chrome', name: 'Google Chrome', path: '/opt/google/chrome/chrome' },
      { choice: 'chromium', name: 'Chromium', path: '/usr/bin/chromium' },
      { choice: 'chromium', name: 'Chromium', path: '/usr/bin/chromium-browser' });
  }
  return candidates.filter(candidate => choice === 'auto' || candidate.choice === choice)
    .filter((candidate, index, all) => all.findIndex(other => other.path === candidate.path) === index)
    .map(({ name, path: executable }) => ({ name, path: executable }));
}

/** Browser child processes never inherit Connector API keys or 1Password sessions. */
export function browserEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATH', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())));
}

/** One isolated browser per Connector session; never attach to an existing user profile. */
export class LocalBrowserRuntime implements BrowserRuntime {
  constructor(private readonly options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {}

  private async executable(choice: BrowserChoice) {
    const platform = this.options.platform || process.platform;
    for (const candidate of browserExecutableCandidates(choice, this.options.env, platform)) {
      try {
        if (!(await stat(candidate.path)).isFile()) continue;
        await access(candidate.path, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* Try only the next known native installation path. */ }
    }
    return undefined;
  }

  async check(choice: BrowserChoice): Promise<BrowserCheck> {
    const installed = await this.executable(choice);
    return installed ? { installed: true, name: installed.name, message: `${installed.name} is available. Bots open a separate browser window on this computer; approve 1Password requests there when prompted.` }
      : { installed: false, message: MISSING };
  }

  async launch(choice: BrowserChoice): Promise<BrowserDriver> {
    const executable = await this.executable(choice);
    if (!executable) throw new ProviderError(MISSING, 503);
    const proxy = await startBrowserProxy();
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ executablePath: executable.path, headless: false, chromiumSandbox: true, timeout: 30_000,
        env: browserEnvironment(this.options.env), proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
        args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-extensions', '--disable-background-networking'],
      });
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', permissions: [] });
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(25_000);
      await context.route('**/*', async route => {
        try { validateBrowserUrl(route.request().url()); await route.continue(); }
        catch { await route.abort('blockedbyclient').catch(EMPTY); }
      });
      // WebSocket traffic has no task-facing API and must not bypass the HTTPS proxy.
      await context.routeWebSocket('**/*', socket => socket.close());
      const page = await context.newPage();
      const driver = new LocalBrowserDriver(browser, context, page, proxy.close);
      context.on('page', popup => { if (popup !== page) void popup.close().catch(EMPTY); });
      return driver;
    } catch {
      await browser?.close().catch(EMPTY);
      await proxy.close();
      throw new ProviderError('Connector could not open its browser window. Make sure a desktop session is available on this computer and try again.', 503);
    }
  }
}

type ElementReference = { handle: ElementHandle<Element>; origin: string; generation: number };

/** Fixed browser operations only. No caller-supplied scripts, selectors, files, or screenshots. */
export class LocalBrowserDriver implements BrowserDriver {
  private readonly references = new Map<string, ElementReference>();
  private readonly secrets = new Set<string>();
  private generation = 0;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly browser: Browser, private readonly context: BrowserContext, private readonly page: Page,
    private readonly stopProxy: () => Promise<void>) {
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      this.invalidate();
      if (frame.url() !== 'about:blank') {
        try { validateBrowserUrl(frame.url()); } catch { void this.close(); }
      }
    });
    page.on('dialog', dialog => { void dialog.dismiss().catch(EMPTY); });
    page.on('download', download => { void download.cancel().catch(EMPTY); });
    page.on('close', () => { this.invalidate(); void this.close(); });
    browser.on('disconnected', () => { void this.close(); });
  }

  private assertOpen() {
    if (this.closed || this.page.isClosed()) throw new ProviderError('This browser session has closed. Open a new browser session.', 409);
  }
  origin(): string {
    if (this.closed || this.page.isClosed()) return '';
    try { return new URL(validateBrowserUrl(this.page.url())).origin; } catch { return ''; }
  }
  private invalidate() {
    this.generation++;
    for (const reference of this.references.values()) void reference.handle.dispose().catch(EMPTY);
    this.references.clear();
  }
  private redact(value: string, limit: number): string {
    let clean = value;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      clean = clean.split(secret).join('[redacted]');
    }
    return clean.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit);
  }
  private remember(credential: BrowserCredential) {
    for (const secret of [credential.username, credential.password]) {
      if (typeof secret !== 'string' || !secret || secret.length > MAX_SECRET || /[\u0000\r\n]/.test(secret)) throw new ProviderError('The selected login does not contain a supported username and password.', 422);
      // document.title and accessibility labels can normalize HTML whitespace.
      // Remember these deterministic representations without copying secrets
      // into later page scripts on different origins.
      for (const value of new Set([secret, secret.trim(), secret.replace(/\s+/g, ' ').trim()])) {
        if (!value) continue;
        for (const variant of [value, encodeURIComponent(value), value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')]) {
          if (this.secrets.size >= MAX_REDACTIONS && !this.secrets.has(variant)) throw new ProviderError('Close this browser session and open a new one before using more saved logins.', 409);
          this.secrets.add(variant);
        }
      }
    }
  }
  private async operation<T>(assertCurrent: () => void, run: () => Promise<T>): Promise<T> {
    assertCurrent(); this.assertOpen();
    try {
      const result = await run();
      assertCurrent(); this.assertOpen();
      return result;
    } catch (error) {
      assertCurrent();
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(OPERATION_FAILED, 409);
    }
  }

  async navigate(url: string, assertCurrent: () => void) {
    const target = validateBrowserUrl(url);
    await this.operation(assertCurrent, async () => {
      this.invalidate(); assertCurrent();
      await this.page.goto(target, { waitUntil: 'domcontentloaded' });
      if (!this.origin()) throw new ProviderError('This browser supports public HTTPS websites only.', 409);
    });
  }

  async snapshot(assertCurrent: () => void): Promise<BrowserPageSnapshot> {
    return this.operation(assertCurrent, async () => {
      this.invalidate();
      const origin = this.origin();
      if (!origin) throw new ProviderError('Open a public HTTPS page before requesting its contents.', 409);
      const generation = this.generation;
      // Keep enough untruncated overlap to redact even a long encoded credential
      // before shortening text for the AI. Values themselves never go back into
      // a later website merely to perform redaction.
      const captureLimit = 12_000 + Math.max(MAX_SECRET, ...[...this.secrets].map(value => value.length)) + 1;
      const capture = await this.page.evaluateHandle(({ selector, expectedOrigin, captureLimit }) => {
        if (window.location.origin !== expectedOrigin) throw new Error('Page changed');
        // Method syntax keeps this fixed script self-contained under tsx's
        // function-name transform (no references to a Node-side helper).
        const helpers = {
          visible(element: Element) {
            const style = getComputedStyle(element);
            return style.visibility !== 'hidden' && style.display !== 'none' && !!element.getClientRects().length && !element.closest('[hidden],[aria-hidden="true"]');
          },
          excluded(element: Element) { return !!element.closest('script,style,noscript,template,input,textarea,select,[contenteditable="true"],[hidden],[aria-hidden="true"]') || [...credentialForms].some(form => form.contains(element)); },
        };
        const credentialForms = new Set<Element>();
        for (const input of document.querySelectorAll('input[type="password"],input[autocomplete="username"],input[autocomplete="current-password"],input[autocomplete="new-password"]')) {
          const form = (input as HTMLInputElement).form;
          if (form) credentialForms.add(form);
        }
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        const parts: string[] = [];
        let length = 0; let count = 0;
        while (walker.nextNode() && count++ < 50_000 && length < captureLimit) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          if (!parent || helpers.excluded(parent) || !helpers.visible(parent)) continue;
          const value = (node.textContent || '').slice(0, captureLimit);
          if (value.trim()) { parts.push(value); length += value.length + 1; }
        }
        const nodes = Array.from(document.querySelectorAll(selector)).filter(helpers.visible).slice(0, 100);
        const elements = nodes.map(element => {
          const input = element instanceof HTMLInputElement;
          const type = input ? element.type : '';
          const declaredRole = element.getAttribute('role') || '';
          const role = ['button', 'link', 'checkbox', 'tab', 'textbox', 'combobox', 'radio', 'switch'].includes(declaredRole) ? declaredRole :
            (element.tagName === 'A' ? 'link' : element.tagName === 'BUTTON' || ['button', 'submit', 'reset'].includes(type) ? 'button' : type === 'password' ? 'password' : ['checkbox', 'radio'].includes(type) ? type : element.tagName === 'SELECT' ? 'combobox' : 'textbox');
          const labelledBy = element.getAttribute('aria-labelledby');
          const labelled = labelledBy ? labelledBy.split(/\s+/).slice(0, 8).map(id => document.getElementById(id)?.textContent || '').join(' ') : '';
          const labels = 'labels' in element ? Array.from((element as HTMLInputElement).labels || []).map(label => label.textContent || '').join(' ') : '';
          const ownText = input || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? '' : element.textContent || '';
          const name = (element.getAttribute('aria-label') || labelled || labels || ownText || element.getAttribute('placeholder') || element.getAttribute('title') || role).slice(0, captureLimit);
          return { role, name };
        });
        return { nodes, result: { title: document.title.slice(0, captureLimit), text: parts.join('\n').slice(0, captureLimit), elements } };
      }, { selector: ELEMENT_SELECTOR, expectedOrigin: origin, captureLimit });
      try {
        const resultHandle = await capture.getProperty('result');
        const result = await resultHandle.jsonValue() as { title: string; text: string; elements: { role: string; name: string }[] };
        await resultHandle.dispose();
        const nodes = await capture.getProperty('nodes');
        const properties = await nodes.getProperties();
        await nodes.dispose();
        assertCurrent();
        if (this.origin() !== origin || this.generation !== generation) {
          for (const handle of properties.values()) await handle.dispose();
          throw new ProviderError(STALE, 409);
        }
        const elements = result.elements.map((element, index) => {
          const handle = properties.get(String(index))?.asElement() as ElementHandle<Element> | null;
          if (!handle) throw new ProviderError(STALE, 409);
          const ref = randomUUID();
          this.references.set(ref, { handle, origin, generation });
          return { ref, role: this.redact(element.role, 60), name: this.redact(element.name, 250) };
        });
        return { origin, title: this.redact(result.title, 300), text: this.redact(result.text, 12_000), elements };
      } finally { await capture.dispose().catch(EMPTY); }
    });
  }

  private reference(ref: string) {
    const reference = this.references.get(ref);
    if (!reference || reference.generation !== this.generation || reference.origin !== this.origin()) throw new ProviderError(STALE, 409);
    return reference;
  }
  async click(ref: string, assertCurrent: () => void) {
    await this.operation(assertCurrent, async () => {
      const reference = this.reference(ref);
      const allowed = await reference.handle.evaluate(element => element.isConnected && !(element instanceof HTMLInputElement && element.type === 'file') && !(element instanceof HTMLAnchorElement && element.hasAttribute('download')));
      assertCurrent(); this.reference(ref);
      if (!allowed) throw new ProviderError('File selection and downloads are not available through browser tools.', 409);
      try { await reference.handle.click({ timeout: 10_000 }); }
      finally { this.invalidate(); }
    });
  }
  async type(ref: string, text: string, assertCurrent: () => void) {
    if (typeof text !== 'string' || text.length > 4000 || /\u0000/.test(text)) throw new ProviderError('Enter at most 4,000 characters of ordinary task text.');
    await this.operation(assertCurrent, async () => {
      const reference = this.reference(ref);
      const allowed = await reference.handle.evaluate(element => {
        if (!element.isConnected) return false;
        if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
        if (!(element instanceof HTMLInputElement) || !['text', 'search', 'tel', 'number', 'url'].includes(element.type) || element.disabled || element.readOnly) return false;
        const clue = `${element.autocomplete} ${element.name} ${element.id}`;
        return !/(?:password|username|login|email|identifier|one-time-code|otp|secret|token)/i.test(clue) && !element.form?.querySelector('input[type="password"]');
      });
      assertCurrent(); this.reference(ref);
      if (!allowed) throw new ProviderError('Use browser sign-in for saved login fields. Browser typing is limited to ordinary text fields.', 409);
      try { await reference.handle.fill(text, { timeout: 10_000 }); }
      finally { this.invalidate(); }
    });
  }

  async fillLogin(origin: string, credential: BrowserCredential, assertCurrent: () => void): Promise<{ filled: 'username' | 'password' | 'username_and_password' }> {
    this.remember(credential);
    if (!credential.origins.includes(origin) || new URL(validateBrowserUrl(origin)).origin !== origin) throw new ProviderError('The saved login does not match this website’s exact HTTPS address.', 409);
    return this.operation(assertCurrent, async () => {
      if (this.origin() !== origin) throw new ProviderError('The website changed while waiting for 1Password. Start sign-in again on the intended website.', 409);
      assertCurrent();
      const result = await this.page.evaluate(({ expectedOrigin, username, password }) => {
        const helpers = {
          visible(input: HTMLInputElement) { return !input.disabled && !input.readOnly && getComputedStyle(input).visibility !== 'hidden' && getComputedStyle(input).display !== 'none' && !!input.getClientRects().length && !input.closest('[hidden],[aria-hidden="true"]'); },
          samePage() { return window.top === window && window.location.protocol === 'https:' && window.location.origin === expectedOrigin; },
          safe(input: HTMLInputElement) {
            if (!helpers.samePage() || !input.isConnected || input.ownerDocument !== document || !helpers.visible(input)) return false;
            const form = input.form;
            if (!form) return true;
            try {
              // DOM properties include the actual document base URL. Resolving
              // raw relative attributes against location would miss <base>.
              const action = new URL(form.action || window.location.href);
              if (action.protocol !== 'https:' || action.origin !== expectedOrigin || action.username || action.password) return false;
              for (const element of Array.from(form.elements)) {
                if (!(element instanceof HTMLButtonElement || element instanceof HTMLInputElement) || !element.hasAttribute('formaction')) continue;
                const override = new URL(element.formAction || window.location.href);
                if (override.protocol !== 'https:' || override.origin !== expectedOrigin || override.username || override.password) return false;
              }
              return true;
            } catch { return false; }
          },
          fill(input: HTMLInputElement, value: string, passwordField: boolean) {
            if (!helpers.safe(input) || !setter || (passwordField && (input.type !== 'password' || input.autocomplete === 'new-password'))) return false;
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          },
        };
        if (!helpers.samePage()) return 'changed';
        const inputs = Array.from(document.querySelectorAll('input')).filter(helpers.visible);
        const passwords = inputs.filter(input => input.type === 'password');
        if (passwords.length > 1 || passwords.some(input => input.autocomplete === 'new-password')) return 'ambiguous';
        const passwordInput = passwords[0];
        const usernames = inputs.filter(input => ['text', 'email', 'tel'].includes(input.type) &&
          (input.type === 'email' || /^(?:username|email)$/.test(input.autocomplete) || /^(?:user(?:name)?|login|email|identifier)$/i.test(input.name) || /^(?:user(?:name)?|login|email|identifier|identifierId)$/i.test(input.id)) &&
          (!passwordInput || input.form === passwordInput.form));
        if (usernames.length > 1 || (!passwordInput && usernames.length !== 1)) return 'ambiguous';
        const usernameInput = usernames[0];
        if ((usernameInput && !helpers.safe(usernameInput)) || (passwordInput && !helpers.safe(passwordInput))) return 'unsafe';
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) return 'unsafe';
        if (usernameInput && !helpers.fill(usernameInput, username, false)) return 'unsafe';
        if (passwordInput && !helpers.fill(passwordInput, password, true)) return 'unsafe';
        return usernameInput && passwordInput ? 'username_and_password' : passwordInput ? 'password' : 'username';
      }, { expectedOrigin: origin, username: credential.username, password: credential.password });
      this.invalidate();
      if (result === 'changed') throw new ProviderError('The website changed while waiting for 1Password. Start sign-in again on the intended website.', 409);
      if (result === 'unsafe') throw new ProviderError('This login form sends credentials to another address or changed during sign-in. Complete it yourself in the browser window.', 409);
      if (result === 'ambiguous') throw new ProviderError('Connector could not identify one supported login form. Open the website’s sign-in page or complete sign-in yourself in the browser window.', 409);
      return { filled: result };
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.invalidate(); this.secrets.clear();
    this.closing = Promise.resolve().then(async () => {
      await this.context.close().catch(EMPTY);
      await this.browser.close().catch(EMPTY);
      await this.stopProxy().catch(EMPTY);
    });
    return this.closing;
  }
}
