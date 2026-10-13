import type express from 'express';
import type { AppConfig } from './config';
import { parseAppOrigin } from './config';
import { ProviderError } from './provider-types';
import type { Store } from './store';

const SETTING = 'tiktok-domain-verification-v1';
const FILENAME = /^tiktok[A-Za-z0-9_-]{0,100}\.txt$/;
const PUBLIC_PATH = /^\/tiktok[A-Za-z0-9_-]{0,100}\.txt$/;
const validFilename = (value: unknown): value is string => typeof value === 'string' && FILENAME.test(value) && value.endsWith('.txt');
interface VerificationFile { filename: string; content: string }
export interface TikTokVerificationStatus { filename: string | null; publicUrl: string | null }

/** Stores only the owner's explicitly published TikTok domain-verification text. */
export class TikTokVerification {
  constructor(private readonly config: AppConfig, private readonly store: Store) {}
  status(): TikTokVerificationStatus {
    const saved = this.store.readSetting<VerificationFile>(SETTING);
    return { filename: saved?.filename || null, publicUrl: saved ? `${parseAppOrigin(this.config.origin).origin}/${saved.filename}` : null };
  }
  save(input: unknown): TikTokVerificationStatus {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderError('Choose the TikTok verification text file.');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !['filename', 'content'].includes(key))) throw new ProviderError('Only the verification filename and content may be provided.');
    if (!validFilename(value.filename)) throw new ProviderError('Use the original TikTok filename: tiktok followed by letters, numbers, underscores or hyphens, ending in .txt.');
    if (typeof value.content !== 'string' || value.content.length === 0 || value.content.includes('\0') || Buffer.byteLength(value.content, 'utf8') > 16_384 || Buffer.from(value.content, 'utf8').toString('utf8') !== value.content) {
      throw new ProviderError('The verification file must contain valid UTF-8 text, no null characters, and at most 16 KB.');
    }
    this.store.writeSetting(SETTING, { filename: value.filename, content: value.content });
    return this.status();
  }
  remove(): TikTokVerificationStatus { this.store.deleteSetting(SETTING); return this.status(); }
  content(filename: string): string | null {
    if (!validFilename(filename)) return null;
    const saved = this.store.readSetting<VerificationFile>(SETTING);
    return saved?.filename === filename ? saved.content : null;
  }
}

export function mountTikTokVerificationPublic(app: express.Express, verification: TikTokVerification) {
  app.get(PUBLIC_PATH, (req, res) => {
    const content = verification.content(req.path.slice(1));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(content === null ? 404 : 200).type('text/plain').send(content === null ? 'TikTok verification file not found.' : content);
  });
}

/** Mount after the existing owner-session, JSON and CSRF middleware. */
export function mountTikTokVerificationOwner(app: express.Express, verification: TikTokVerification) {
  app.get('/api/tiktok/verification', (_req, res) => res.setHeader('Cache-Control', 'no-store').json(verification.status()));
  app.put('/api/tiktok/verification', (req, res) => res.setHeader('Cache-Control', 'no-store').json(verification.save(req.body)));
  app.delete('/api/tiktok/verification', (_req, res) => res.setHeader('Cache-Control', 'no-store').json(verification.remove()));
}
