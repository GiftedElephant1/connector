import type express from 'express';
import type { AppConfig } from './config';
import type { Store } from './store';
import { ProviderError } from './provider-types';
import { loadTunnelDriver, type Listener, type TunnelDriver } from './tunnel-driver';

export type { TunnelDriver } from './tunnel-driver';
type SavedTunnel = { authtoken: string; domain?: string; autoStart: boolean };
type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error';

/** Parse dashboard clipboard text as data; never execute a pasted command. */
function parseAuthtoken(input: string): string {
  let token = input.trim().replace(/^(?:\.\\|\.\/)?ngrok(?:\.exe)?\s+config\s+add-authtoken(?:\s+|$)/i, '').trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  if (!token) throw new ProviderError('Enter your ngrok authtoken. Open “Your Authtoken” in the ngrok dashboard and click the copy icon beside the token.');
  if (token.startsWith('$') || /^(?:(?:YOUR[_-])?(?:NGROK[_-])?(?:AUTH[_-]?TOKEN|TOKEN)|<.*>|\[.*\]|\*+|[.•●]+)$/i.test(token)) {
    throw new ProviderError('That looks like a placeholder or a hidden token. On ngrok’s “Your Authtoken” page, click the copy icon beside your actual token, then replace the contents of this box.');
  }
  if (/^https?:\/\//i.test(token)) throw new ProviderError('That is a website address. This box needs your ngrok authtoken from the “Your Authtoken” page, not your public URL or the dashboard URL.');
  // The SDK does not define a token alphabet or minimum length. Let ngrok
  // validate the credential, while catching multi-line/extra clipboard text.
  if (token.length > 4096 || /[^\x21-\x7e]/.test(token)) {
    throw new ProviderError('The pasted text contains extra text, spaces, or unsupported characters. Copy your token with the copy icon on ngrok’s “Your Authtoken” page, then replace everything in this box.');
  }
  return token;
}

/** Owns one HTTPS listener. The upstream is fixed to this app, never user supplied. */
export class PublicTunnel {
  private listener?: Listener;
  private activeDriver?: TunnelDriver;
  private opening?: Promise<Listener>;
  private status: TunnelStatus = 'stopped';
  private url?: string;
  private error?: string;
  private generation = 0;
  private changing = false;

  constructor(
    private config: AppConfig,
    private store: Store,
    private applyOrigin: (origin: string) => void,
    private driver: () => Promise<TunnelDriver> = loadTunnelDriver,
    private timeoutMs = 30_000,
  ) {}

  snapshot() {
    const saved = this.store.readSetting<SavedTunnel>('public-tunnel');
    return { available: true, status: this.status, needsStop: !!(this.listener || this.activeDriver || this.opening), configured: !!saved?.authtoken, domain: saved?.domain || '', autoStart: saved?.autoStart || false, ...(this.url ? { url: this.url } : {}), ...(this.error ? { error: this.error } : {}) };
  }

  private async closeOwned() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closing = async () => {
      // The runtime driver closes its own session transport. Listener.close()
      // alone is an RPC and can fail when that transport has disconnected.
      if (this.activeDriver?.close) return this.activeDriver.close();
      const listener = this.listener || await this.opening?.catch(() => undefined);
      if (listener) await listener.close();
    };
    try {
      await Promise.race([closing(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Public connection cleanup timed out.')), Math.min(this.timeoutMs, 5_000));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private clearOwned() {
    this.listener = undefined;
    this.activeDriver = undefined;
    this.opening = undefined;
    this.url = undefined;
  }

  async start(input: { authtoken?: unknown; domain?: unknown } = {}) {
    if (this.changing) throw new ProviderError('Public access is changing. Wait a moment and try again.', 409);
    if (this.listener || this.activeDriver || this.opening) throw new ProviderError('Stop the current public connection before changing it.', 409);
    const saved = this.store.readSetting<SavedTunnel>('public-tunnel');
    if (input.authtoken !== undefined && typeof input.authtoken !== 'string') throw new ProviderError('Enter a valid ngrok authtoken.');
    const authtoken = parseAuthtoken((typeof input.authtoken === 'string' ? input.authtoken.trim() : '') || saved?.authtoken || '');
    if (input.domain !== undefined && typeof input.domain !== 'string') throw new ProviderError('Enter only your assigned ngrok hostname.');
    const domain = (typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : saved?.domain) || undefined;
    if (domain && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) || domain.endsWith('.localhost') || domain.endsWith('.local'))) {
      throw new ProviderError('Enter your assigned hostname without https://, a port, or a path.');
    }
    this.changing = true;
    this.status = 'starting';
    this.error = undefined;
    const generation = ++this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let candidate: Listener | undefined;
    let connectionStatus = 'connected';
    try {
      const opening = this.driver().then(driver => {
        if (generation !== this.generation) throw new Error('Public connection opening was cancelled.');
        this.activeDriver = driver;
        return driver.forward({
          addr: `http://127.0.0.1:${this.config.port}`,
          authtoken, ...(domain ? { domain } : {}), force_new_session: true,
          onStatusChange: status => {
            if (generation !== this.generation) return;
            connectionStatus = status;
            if (!this.listener) return;
            if (status === 'closed') { this.status = 'error'; this.error = 'The public connection was interrupted. Check your Internet connection or stop and reconnect.'; }
            if (status === 'connected') { this.status = 'running'; this.error = undefined; }
          },
        });
      });
      this.opening = opening;
      candidate = await Promise.race([opening, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Public connection timed out.')), this.timeoutMs);
      })]);
      const address = candidate.url();
      let parsed: URL;
      try { parsed = new URL(address || ''); } catch { throw new Error('Invalid public address.'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid public address.');
      this.applyOrigin(parsed.origin);
      this.store.writeSetting('public-tunnel', { authtoken, domain, autoStart: true } satisfies SavedTunnel);
      this.listener = candidate;
      this.opening = undefined;
      this.url = parsed.origin;
      this.status = connectionStatus === 'closed' ? 'error' : 'running';
      if (this.status === 'error') this.error = 'The public connection was interrupted. Check your Internet connection or stop and reconnect.';
      return this.snapshot();
    } catch (cause) {
      ++this.generation;
      let cleanupFailed = false;
      try { await this.closeOwned(); this.clearOwned(); }
      catch { cleanupFailed = true; }
      this.status = 'error';
      // Only the documented error identifier is safe to show; SDK messages can include credentials.
      const code = cause instanceof Error ? cause.message.match(/\bERR_NGROK_\d{1,6}\b/)?.[0] : undefined;
      this.error = `Could not open public access${code ? ` (${code})` : ''}. Check your ngrok authtoken, assigned domain, and Internet connection, then try again.`;
      if (cleanupFailed) this.error = 'Could not open public access, and its session could not be closed. Try Stop public access. If that fails, right-click Connector beside the Windows clock and choose Stop Connector, then reopen your original installation. Closing the browser alone does not stop Connector.';
      throw new ProviderError(this.error, 502);
    } finally {
      if (timer) clearTimeout(timer);
      this.changing = false;
    }
  }

  async stop(preserveAutoStart = false) {
    if (this.changing) throw new ProviderError('Public access is changing. Wait a moment and try again.', 409);
    this.changing = true;
    ++this.generation;
    try {
      // Preserve the explicit stop preference even if transport cleanup fails.
      const saved = this.store.readSetting<SavedTunnel>('public-tunnel');
      if (saved && !preserveAutoStart) this.store.writeSetting('public-tunnel', { ...saved, autoStart: false });
      await this.closeOwned();
      this.clearOwned();
      this.status = 'stopped';
      this.error = undefined;
      return this.snapshot();
    } catch {
      this.status = 'error';
      this.error = 'Could not close public access. Right-click Connector beside the Windows clock and choose Stop Connector, then reopen your original installation. Closing the browser alone does not stop Connector.';
      throw new ProviderError(this.error, 502);
    } finally { this.changing = false; }
  }

  async restore() {
    if (this.store.readSetting<SavedTunnel>('public-tunnel')?.autoStart) await this.start();
  }
}

/** Mount only after authenticated owner session and CSRF middleware. */
export function mountTunnel(app: express.Express, tunnel: PublicTunnel) {
  app.get('/api/tunnel', (_req, res) => res.json(tunnel.snapshot()));
  app.post('/api/tunnel/start', async (req, res) => res.json(await tunnel.start({ authtoken: req.body?.authtoken, domain: req.body?.domain })));
  app.post('/api/tunnel/stop', async (_req, res) => res.json(await tunnel.stop()));
}
