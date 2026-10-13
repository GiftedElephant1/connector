import type express from 'express';
import type { AppConfig } from './config';
import { parseAppOrigin } from './config';
import { ProviderError } from './provider-types';
import type { Store } from './store';

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

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
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
    const name = escapeHtml(current.operatorName);
    const email = escapeHtml(current.contactEmail);
    const contact = `<a href="${escapeHtml(`mailto:${encodeURIComponent(current.contactEmail)}`)}">${email}</a>`;
    const title = kind === 'terms' ? 'Terms of Service' : kind === 'privacy' ? 'Privacy Policy' : 'About Connector';
    const effective = current.updatedAt ? `<p class="metadata">Effective date: <time datetime="${escapeHtml(current.updatedAt)}">${escapeHtml(current.updatedAt.slice(0, 10))}</time> (UTC). Operator: ${name}.</p>` : '';
    const incomplete = '<div class="notice"><strong>Public policy setup is incomplete.</strong> The owner must save the operator name and contact email in Connector before submitting these URLs to a platform for review.</div>';
    const description = `<p>Connector is a self-hosted account integration app. Its owner connects their own social media, communications, advertising, productivity and other supported accounts, then uses the dashboard or an authorized AI assistant to run available actions through those platforms’ APIs.</p>
      <p>Connector runs on the owner’s computer or chosen server. This installation has an owner sign-in; it is not a public service where visitors can create accounts. Connected accounts, notes and private dashboard data are not displayed on these public pages.</p>
      <h2>What the app does</h2><p>Supported integrations can publish and schedule content, read available metrics, manage supported advertising actions, and access selected workspace data. Capabilities depend on each platform’s permissions and approvals. Obsidian access uses the local vault selected by the owner, and Plaid bank actions are read-only.</p>
      <h2>TikTok integration</h2><p>The owner can authorize their TikTok account, verify the account identity, check creator publishing options, submit a video through the Content Posting API, check submission status, and retrieve available metrics for an owned video through the Display API. These features require the relevant TikTok permissions and review. Connector does not claim that this installation or these products have been approved by TikTok.</p>
      <h2>AI access</h2><p>An AI app that supports remote MCP connectors can request access to this installation. The owner signs in to Connector and chooses what access to approve. The AI provider receives the results of tools it is authorized to call and handles those results under its own terms and privacy practices.</p>`;
    const terms = `<p>These terms apply to this Connector installation operated by ${name}. For questions about this installation, contact ${contact}.</p>
      <h2>Authorized use</h2><p>Use this installation only if the operator has authorized you to do so. Connect only accounts, websites and data you own or are permitted to manage. Protect the owner password, connector keys and access to the computer or server running Connector.</p>
      <h2>Your content and actions</h2><p>You are responsible for the content and instructions you submit, your right to use that content, and the actions you approve. Review the destination account, audience, privacy, schedule and any advertising spend before confirming an action. AI-generated instructions and content can be incorrect. Do not use the app for unlawful activity, spam, impersonation or violations of another person’s rights.</p>
      <h2>Platform and AI provider requirements</h2><p>Connected services remain subject to their own terms, permissions, eligibility, review processes, usage limits and charges. Connector is an independent integration tool and is not endorsed by those services. Availability of a connector does not guarantee platform approval, access to a particular feature, publication, message delivery or campaign performance.</p>
      <h2>Operation and availability</h2><p>The app and any required internet connection must remain running for scheduled work and remote AI access. A platform may delay or reject an action, credentials may expire, and network or software failures may interrupt work. Check the platform before retrying an uncertain action. Keep backups and review activity in the app and on the connected platform.</p>
      <h2>Ending access and removing data</h2><p>The owner can disconnect accounts, revoke AI grants and cancel pending jobs. Disconnecting an account removes its stored connection credential and account summary; it does not remove existing job history or content already sent to a platform. See the <a href="/privacy">Privacy Policy</a> for retention and deletion information. The operator may stop running this installation or withdraw access.</p>
      <h2>Changes and applicable rights</h2><p>The operator may update these terms when this installation changes. The effective date above identifies the current notice. Nothing in these terms removes rights or obligations that applicable law does not allow to be excluded.</p>`;
    const privacy = `<p>This policy describes data handled by this self-hosted Connector installation. Its operator is ${name}; privacy questions and deletion requests can be sent to ${contact}. It applies to this installation, not to the independent services you connect.</p>
      <h2>Data processed</h2><p>When an account is connected, Connector stores the access credentials needed to use the platform and an account summary such as its identifier, display name and available resources. It also processes configuration, AI access permissions, authorization metadata, action inputs, scheduling information, job status, results and error messages. Depending on the tools used, inputs and results may contain posts, video links, comments, messages, analytics, advertising data, workspace documents, email, notes or bank account and transaction information.</p>
      <p>TikTok connection verification reads the authorized account’s basic profile. Publishing requests send the selected caption, video source URL, privacy and interaction choices, commercial-content and AI-content declarations, and the required consent to TikTok. Creator settings, publishing status and selected owned-video metrics are read from TikTok as requested. TikTok retrieves submitted video media from its supplied source URL.</p>
      <h2>Why data is used</h2><p>The app uses this data to authenticate accounts, maintain approved access, carry out requested actions, run confirmed schedules, display results, prevent duplicate submissions, and show failures for troubleshooting. The public operator name and contact email are displayed on these policy pages. A TikTok website-verification text file explicitly uploaded by the owner is publicly served at its verification URL until replaced or removed.</p>
      <h2>Where data goes</h2><p>Requests and necessary data are sent to the selected platform through its API. Authorized AI clients receive tool results they request; the app does not control those providers’ retention or use of results. Platforms, AI providers and any hosting or tunnel provider selected by the operator (such as ngrok) process relevant traffic under their own policies. Network infrastructure also handles connection metadata. The app does not include an advertising tracker or a facility for selling connected-account data.</p>
      <p>Obsidian reads and writes the local vault folder selected by the owner. When Obsidian Sync is enabled in the desktop app, that separate app may sync changes to the owner’s cloud vault. Connector does not collect the Obsidian Sync password. Bank linking uses Plaid Link; Connector receives a Plaid access token and supported account, balance and transaction data, not the bank login credentials entered into Plaid Link. Bank tools do not transfer funds.</p>
      <h2>Storage and security</h2><p>Records are stored in the installation’s local database on the owner’s computer or chosen server. Connector encrypts stored platform credentials, saved settings, job inputs and job results. Some metadata, including account summaries, job identifiers, timestamps, statuses and error messages, is not encrypted by the app. The encryption key is kept in the installation’s local configuration, so protection of the device, configuration and backups remains important. Platform credentials and the encryption key are not published by these pages.</p>
      <h2>Cookies and authorization records</h2><p>The dashboard uses a necessary sign-in session cookie with a lifetime of up to 12 hours. Short-lived authorization state links a platform sign-in to the owner’s session. AI authorization uses limited-life access and refresh tokens; expired or revoked grants and token records are cleaned during authorization activity. Previously approved AI client registration metadata may remain for reconnection, subject to a bounded registration limit. These public policy pages do not require sign-in and do not add tracking cookies.</p>
      <h2>Retention, disconnecting and deletion</h2><p>Connection credentials and account summaries remain until disconnected or removed by the operator. Settings and job inputs, history and stored results remain until explicitly removed from the installation; there is no automatic job-history deletion schedule. A cancelled job can still appear in history. Disconnecting an account removes that connection’s stored credential and account summary, but does not erase previous job records or platform-side content. Revoking an AI connection stops future access through that grant; it does not retrieve results already sent to the AI provider.</p>
      <p>Contact the operator to request access, correction or deletion of data held by this installation. Because some records do not have a per-record deletion control, removing all installation data may require the operator to stop the app and delete its database and relevant backups. Local Obsidian notes, external platforms and AI providers hold their own copies separately. Remove content there or use those providers’ privacy controls as appropriate. The operator should retain data only as needed for the purposes above and applicable obligations.</p>
      <h2>Your choices and changes to this policy</h2><p>You can decline platform or AI authorization, select available permissions, disconnect accounts, revoke approved AI access and cancel pending scheduled actions. Data rights depend on applicable law and the operator’s circumstances; use the contact above to make a request. The operator may revise this notice when the installation changes; the effective date identifies the current version.</p>`;
    const content = kind === 'about' ? `${description}${current.configured ? `<h2>Operator and contact</h2><p>This installation is operated by ${name}. Contact: ${contact}.</p>` : incomplete}` : current.configured ? `${effective}${kind === 'terms' ? terms : privacy}` : incomplete;
    return { status: kind !== 'about' && !current.configured ? 503 : 200, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Connector</title><meta name="description" content="${title} for this self-hosted Connector installation."><link rel="stylesheet" href="/legal/style.css"><link rel="icon" type="image/png" href="/assets/connector-icon.png"></head><body><header><a class="brand" href="/about"><img src="/assets/connector-icon.png" alt="" width="36" height="36">Connector</a><nav aria-label="Public pages"><a href="/about"${kind === 'about' ? ' aria-current="page"' : ''}>About</a><a href="/terms"${kind === 'terms' ? ' aria-current="page"' : ''}>Terms</a><a href="/privacy"${kind === 'privacy' ? ' aria-current="page"' : ''}>Privacy</a><a href="/">Owner sign-in</a></nav></header><main><h1>${title}</h1>${content}</main><footer>Self-hosted account integrations · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a></footer></body></html>` };
  }
}

export function mountLegalPublic(app: express.Express, legal: LegalPages) {
  app.get('/legal/style.css', (_req, res) => res.setHeader('Cache-Control', 'public, max-age=3600').type('text/css').send(`:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17233a;background:#f6f8fc}*{box-sizing:border-box}body{margin:0;line-height:1.65}a{color:#214d9e;text-underline-offset:.2em}header,main,footer{max-width:880px;margin:auto;padding:24px}header{display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid #d9e1ef}nav{display:flex;flex-wrap:wrap;gap:16px;font-size:.94rem}nav a[aria-current]{font-weight:700}.brand{display:flex;align-items:center;gap:10px;font-size:1.3rem;font-weight:750;text-decoration:none;color:#17233a}main{padding-top:40px;padding-bottom:48px}h1{font-size:clamp(2rem,6vw,2.8rem);line-height:1.2;letter-spacing:-.03em;margin:0 0 24px}h2{font-size:1.25rem;margin-top:32px;line-height:1.4}p{margin:14px 0;overflow-wrap:anywhere}.metadata{color:#536078;font-size:.95rem}.notice{border:1px solid #c39a43;background:#fff5da;padding:20px;border-radius:10px}.notice strong{display:block}footer{border-top:1px solid #d9e1ef;color:#536078;font-size:.87rem}@media(max-width:600px){header{align-items:flex-start;flex-direction:column;gap:16px}header,main,footer{padding-left:20px;padding-right:20px}}`));
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
