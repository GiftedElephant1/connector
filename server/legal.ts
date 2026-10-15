import type express from 'express';
import type { AppConfig } from './config';
import { parseAppOrigin } from './config';
import { ProviderError } from './provider-types';
import type { Store } from './store';
import { publicPageStyles, renderPublicPage } from './public-pages';

const SETTING = 'public-legal-profile-v1';
interface PublicProfile { operatorName: string; contactEmail: string; updatedAt: string }
const DEFAULT_PROFILE: PublicProfile = {
  operatorName: 'Vectre Pay Inc', contactEmail: 'contact@vectrepay.com', updatedAt: '2026-10-13T22:35:46.000Z',
};
export interface LegalStatus {
  operatorName: string;
  contactEmail: string;
  updatedAt: string | null;
  configured: boolean;
  publicOrigin: string;
  termsUrl: string;
  privacyUrl: string;
  aboutUrl: string;
  iconUrl: string;
}

function profile(input: unknown): Pick<PublicProfile, 'operatorName' | 'contactEmail'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderError('Provide the public operator name and contact email.');
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some(key => !['operatorName', 'contactEmail'].includes(key))) throw new ProviderError('Only the public operator name and contact email can be changed here.');
  if (typeof fields.operatorName !== 'string' || typeof fields.contactEmail !== 'string') throw new ProviderError('Provide the public operator name and contact email.');
  const operatorName = fields.operatorName.trim();
  const contactEmail = fields.contactEmail.trim();
  if (!operatorName || operatorName.length > 120 || /[\u0000-\u001f\u007f]/.test(fields.operatorName)) throw new ProviderError('Use an operator name between 1 and 120 characters, without control characters.');
  const [local, domain, extra] = contactEmail.split('@');
  if (contactEmail.length > 254 || !local || local.length > 64 || !domain || extra !== undefined
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(domain)
    || domain.split('.').some(label => label.length > 63 || label.startsWith('-') || label.endsWith('-'))
    || /[\u0000-\u0020\u007f]/.test(fields.contactEmail)) throw new ProviderError('Enter a valid public contact email address.');
  return { operatorName, contactEmail };
}

/** Public notices describe this installation, never the private account catalogue. */
export class LegalPages {
  constructor(private readonly config: AppConfig, private readonly store: Store) {}
  status(): LegalStatus {
    const saved = this.store.readSetting<PublicProfile>(SETTING) ?? DEFAULT_PROFILE;
    const publicOrigin = parseAppOrigin(this.config.origin).origin;
    return {
      operatorName: saved.operatorName || '', contactEmail: saved.contactEmail || '', updatedAt: saved.updatedAt || null,
      configured: !!saved?.operatorName && !!saved?.contactEmail,
      publicOrigin, termsUrl: `${publicOrigin}/terms`, privacyUrl: `${publicOrigin}/privacy`, aboutUrl: `${publicOrigin}/about`, iconUrl: `${publicOrigin}/assets/connector-icon.png`,
    };
  }
  save(input: unknown): LegalStatus {
    const next = profile(input);
    this.store.writeSetting(SETTING, { ...next, updatedAt: new Date().toISOString() });
    return this.status();
  }
  page(kind: 'terms' | 'privacy' | 'about'): { status: number; html: string } {
    const current = this.status();
    return { status: kind !== 'about' && !current.configured ? 503 : 200, html: renderPublicPage(kind, current, { homePath: '/about', ownerUrl: '/' }) };
  }
}

export function mountLegalPublic(app: express.Express, legal: LegalPages) {
  app.get('/legal/style.css', (_req, res) => res.setHeader('Cache-Control', 'public, max-age=3600').type('text/css').send(publicPageStyles));
  for (const kind of ['terms', 'privacy', 'about'] as const) app.get(`/${kind}`, (_req, res) => {
    const page = legal.page(kind);
    res.setHeader('Cache-Control', 'no-store').status(page.status).type('html').send(page.html);
  });
}

/** Mount after the app's owner-session and CSRF middleware. */
export function mountLegalOwner(app: express.Express, legal: LegalPages) {
  app.get('/api/legal', (_req, res) => res.setHeader('Cache-Control', 'no-store').json(legal.status()));
  app.put('/api/legal', (req, res) => res.setHeader('Cache-Control', 'no-store').json(legal.save(req.body)));
}
