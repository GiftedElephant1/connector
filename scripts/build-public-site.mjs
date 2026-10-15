import { readFile, writeFile, mkdir, copyFile, rm, rename, mkdtemp } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPublicPage, publicPageStyles } from '../server/public-pages.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const escapeHtml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// The only configuration read by this builder is this public, committed file.
// Never load dotenv, application settings, credentials, or the runtime database.
function parseProfile(value) {
  const keys = ['operatorName', 'contactEmail', 'updatedAt', 'siteUrl', 'customDomain'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('The public site profile must contain only its documented public fields.');
  if (typeof value.operatorName !== 'string' || !value.operatorName.trim() || value.operatorName.length > 120 || /[\u0000-\u001f\u007f]/.test(value.operatorName)) throw new Error('Set a valid public operator name.');
  if (typeof value.contactEmail !== 'string' || value.contactEmail.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.contactEmail)) throw new Error('Set a valid public contact email.');
  if (typeof value.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Set the policy effective date as an ISO UTC timestamp.');
  return { ...value, operatorName: value.operatorName.trim(), configured: true };
}

function parseSiteUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\%]/.test(value)) throw new Error('SITE_URL must be an HTTPS URL with an optional plain project path.');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(parsed.hostname)
    || parsed.hostname.endsWith('.localhost') || parsed.hostname.endsWith('.local')) throw new Error('SITE_URL must use a public HTTPS hostname without credentials, a port, query, or fragment.');
  const rawPath = value.slice(value.indexOf('://') + 3).replace(/^[^/]+/, '');
  const segments = rawPath.replace(/^\//, '').replace(/\/$/, '').split('/');
  if (rawPath && rawPath !== '/' && segments.some(segment => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment))) throw new Error('SITE_URL project paths must use letters, numbers, hyphens, or underscores, with no dots or traversal.');
  const basePath = parsed.pathname.replace(/\/$/, '');
  return { origin: parsed.origin, basePath, url: `${parsed.origin}${basePath}` };
}

async function build() {
  const profile = parseProfile(JSON.parse(await readFile(join(repository, 'client/public-profile.json'), 'utf8')));
  const site = parseSiteUrl(process.env.SITE_URL ?? profile.siteUrl);
  // A project-URL preview must not claim or redirect to the production domain.
  // An explicit override may clear the custom domain with an empty string.
  const customDomain = process.env.PUBLIC_SITE_CUSTOM_DOMAIN ?? (site.url === profile.siteUrl?.replace(/\/$/, '') ? profile.customDomain : '');
  if (customDomain && (customDomain !== new URL(site.url).hostname || site.basePath || /(?:^|\.)github\.io$/i.test(customDomain))) throw new Error('The custom domain must match the root SITE_URL and must be an owned domain, not github.io.');
  const parent = resolve('artifacts');
  const output = join(parent, 'public-site');
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.public-site-'));
  try {
    const options = { basePath: site.basePath, homePath: '/', canonicalOrigin: site.origin };
    for (const kind of ['home', 'about', 'privacy', 'terms']) {
      const html = renderPublicPage(kind, profile, options);
      const target = kind === 'home' ? staging : join(staging, kind);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'index.html'), html);
    }
    await mkdir(join(staging, 'legal'), { recursive: true });
    await writeFile(join(staging, 'legal/style.css'), publicPageStyles);
    await mkdir(join(staging, 'assets'), { recursive: true });
    await copyFile(join(repository, 'client/public/assets/connector-icon.png'), join(staging, 'assets/connector-icon.png'));
    // Publish only this owner-supplied public TikTok ownership-verification file.
    const verificationFile = 'tiktokXduTpCHW4SKFGSCTM6kVlGMJwl7SwrjQ.txt';
    await copyFile(join(repository, 'docs/verification', verificationFile), join(staging, verificationFile));
    await writeFile(join(staging, '.nojekyll'), '');
    if (customDomain) await writeFile(join(staging, 'CNAME'), `${customDomain}\n`);
    const home = escapeHtml(`${site.basePath}/`);
    await writeFile(join(staging, '404.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found · Connector</title><link rel="stylesheet" href="${escapeHtml(site.basePath)}/legal/style.css"></head><body><main><h1>Page not found</h1><p>This is Connector’s public information website. Account connections and OAuth callbacks run in your separate Connector workspace.</p><p><a href="${home}">Return to the Connector homepage</a></p></main></body></html>`);
    // Only this dedicated generated directory is replaced; the private app's
    // dist/, data/, .env and saved credentials are never read or written.
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    console.log(`Built public pages for ${site.url}/ in ${output}`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

build().catch(error => {
  console.error(error instanceof Error ? error.message : 'Could not build the public website.');
  process.exitCode = 1;
});
