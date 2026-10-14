import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Credential, VerifiedAccount } from './providers';
import type { ActionResult, ActionValues } from './action-types';
import { ProviderError } from './provider-types';

export interface Job {
  id: string;
  provider: string;
  action: string;
  scheduledAt: string;
  createdAt: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
  finishedAt?: string;
  result?: ActionResult;
  error?: string;
}

export interface Connection extends VerifiedAccount {
  provider: string;
  lastVerifiedAt: string;
  status: 'connected' | 'error';
  error?: string;
}

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class Store {
  private db: DatabaseSync;
  private connectionGenerations = new Map<string, number>();
  constructor(path: string, private key: Buffer) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS connections (provider TEXT PRIMARY KEY, secret TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states (id TEXT PRIMARY KEY, session TEXT NOT NULL, provider TEXT NOT NULL, payload TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, provider TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, scheduled INTEGER NOT NULL, created INTEGER NOT NULL, status TEXT NOT NULL, finished INTEGER, result TEXT, error TEXT);
    `);
  }
  seal(value: unknown, purpose: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.');
  }
  open<T>(value: string, purpose: string): T {
    const [iv, tag, body] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')) as T;
  }
  connection(provider: string): Connection | null {
    const row = this.db.prepare('SELECT summary FROM connections WHERE provider = ?').get(provider);
    return row ? JSON.parse(String(row.summary)) : null;
  }
  credential(provider: string): Credential | null {
    const row = this.db.prepare('SELECT secret FROM connections WHERE provider = ?').get(provider);
    return row ? this.open<Credential>(String(row.secret), `credential:${provider}`) : null;
  }
  save(provider: string, credential: Credential, account: VerifiedAccount): Connection {
    const connection: Connection = { ...account, provider, lastVerifiedAt: new Date().toISOString(), status: 'connected' };
    this.db.prepare('INSERT INTO connections (provider, secret, summary) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET secret=excluded.secret, summary=excluded.summary')
      .run(provider, this.seal(credential, `credential:${provider}`), JSON.stringify(connection));
    return connection;
  }
  markError(provider: string, message: string) {
    const connection = this.connection(provider);
    if (connection) this.db.prepare('UPDATE connections SET summary=? WHERE provider=?').run(JSON.stringify({ ...connection, status: 'error', error: message }), provider);
  }
  updateCredential(provider: string, credential: Credential) {
    this.db.prepare('UPDATE connections SET secret=? WHERE provider=?').run(this.seal(credential, `credential:${provider}`), provider);
  }
  connectionGeneration(provider: string): number { return this.connectionGenerations.get(provider) || 0; }
  assertConnectionGeneration(provider: string, generation: number): void {
    if (generation !== this.connectionGeneration(provider)) throw new ProviderError('This connector was disconnected or reset while the request was running. Start a new connection.', 409);
  }
  invalidateOAuth(provider: string): void { this.db.prepare('DELETE FROM oauth_states WHERE provider=?').run(provider); }
  pendingJobs(providers: string[], prefixes: string[] = []): number {
    return this.db.prepare("SELECT provider, COUNT(*) AS count FROM jobs WHERE status='pending' GROUP BY provider").all()
      .filter(row => providers.includes(String(row.provider)) || prefixes.some(prefix => String(row.provider).startsWith(prefix)))
      .reduce((total, row) => total + Number(row.count), 0);
  }
  disconnect(provider: string) {
    this.connectionGenerations.set(provider, this.connectionGeneration(provider) + 1);
    this.invalidateOAuth(provider);
    if (provider === 'plaid') this.invalidateOAuth('plaid-link');
    this.db.prepare("UPDATE jobs SET status='cancelled',finished=? WHERE provider=? AND status='pending'").run(Date.now(), provider);
    this.db.prepare('DELETE FROM connections WHERE provider=?').run(provider);
  }
  readSetting<T>(name: string): T | null {
    const row = this.db.prepare('SELECT payload FROM settings WHERE name=?').get(name);
    return row ? this.open<T>(String(row.payload), `setting:${name}`) : null;
  }
  writeSetting(name: string, value: unknown) {
    this.db.prepare('INSERT INTO settings (name,payload) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload')
      .run(name, this.seal(value, `setting:${name}`));
  }
  deleteSetting(name: string) { this.db.prepare('DELETE FROM settings WHERE name=?').run(name); }
  deleteAllSessions() {
    this.db.exec('DELETE FROM sessions; DELETE FROM oauth_states;');
  }
  createSession(): string {
    this.cleanup();
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (id, expires) VALUES (?, ?)').run(hash(token), Date.now() + 12 * 60 * 60 * 1000);
    return token;
  }
  validSession(token: string): boolean {
    return !!this.db.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').get(hash(token), Date.now());
  }
  deleteSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(hash(token));
    this.db.prepare('DELETE FROM oauth_states WHERE session=?').run(hash(token));
  }
  saveOAuth(state: string, session: string, provider: string, verifier: string) {
    this.cleanup();
    this.db.prepare('INSERT INTO oauth_states (id, session, provider, payload, expires) VALUES (?, ?, ?, ?, ?)')
      .run(hash(state), hash(session), provider, this.seal({ verifier }, `oauth:${state}`), Date.now() + 10 * 60 * 1000);
  }
  takeOAuth(state: string, session: string, provider: string): { verifier: string } | null {
    const row = this.db.prepare('SELECT * FROM oauth_states WHERE id=? AND session=? AND provider=? AND expires>?')
      .get(hash(state), hash(session), provider, Date.now());
    if (!row) return null;
    this.db.prepare('DELETE FROM oauth_states WHERE id=?').run(hash(state));
    return this.open(String(row.payload), `oauth:${state}`);
  }
  private cleanup() {
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    this.db.prepare('DELETE FROM oauth_states WHERE expires<=?').run(Date.now());
  }
  createJob(id: string, fingerprint: string, provider: string, action: string, values: ActionValues, scheduled: number): Job {
    this.db.prepare('INSERT INTO jobs(id,fingerprint,provider,action,payload,scheduled,created,status) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, fingerprint, provider, action, this.seal(values, `job:${id}`), scheduled, Date.now(), 'pending');
    return this.job(id)!;
  }
  jobFingerprint(id: string): string | null {
    const row = this.db.prepare('SELECT fingerprint FROM jobs WHERE id=?').get(id);
    return row ? String(row.fingerprint) : null;
  }
  private jobFromRow(row: Record<string, unknown>): Job {
    return {
      id: String(row.id), provider: String(row.provider), action: String(row.action), status: String(row.status) as Job['status'],
      scheduledAt: new Date(Number(row.scheduled)).toISOString(), createdAt: new Date(Number(row.created)).toISOString(),
      ...(row.finished ? { finishedAt: new Date(Number(row.finished)).toISOString() } : {}),
      ...(row.result ? { result: this.open<ActionResult>(String(row.result), `job-result:${row.id}`) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
    };
  }
  job(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    return row ? this.jobFromRow(row) : null;
  }
  jobs(): Job[] { return this.db.prepare('SELECT * FROM jobs ORDER BY created DESC LIMIT 100').all().map(row => this.jobFromRow(row)); }
  dueJobs(): Job[] { return this.db.prepare("SELECT * FROM jobs WHERE status='pending' AND scheduled<=? ORDER BY scheduled LIMIT 10").all(Date.now()).map(row => this.jobFromRow(row)); }
  jobValues(id: string): ActionValues {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id);
    if (!row) throw new Error('Missing job.');
    return this.open<ActionValues>(String(row.payload), `job:${id}`);
  }
  claimJob(id: string): boolean { return this.db.prepare("UPDATE jobs SET status='running' WHERE id=? AND status='pending'").run(id).changes === 1; }
  finishJob(id: string, status: 'succeeded' | 'failed' | 'uncertain', result?: ActionResult, error?: string) {
    this.db.prepare('UPDATE jobs SET status=?,finished=?,result=?,error=? WHERE id=?').run(status, Date.now(), result ? this.seal(result, `job-result:${id}`) : null, error || null, id);
  }
  cancelJob(id: string): boolean { return this.db.prepare("UPDATE jobs SET status='cancelled',finished=? WHERE id=? AND status='pending'").run(Date.now(), id).changes === 1; }
  recoverJobs() { this.db.prepare("UPDATE jobs SET status='uncertain',finished=?,error=? WHERE status='running'").run(Date.now(), 'The server restarted during this action. Check the platform before submitting it again.'); }
  close() { this.db.close(); }
}
