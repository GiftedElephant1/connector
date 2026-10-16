import { fetchJson, isObject, safeCredential, type JsonObject, type ProviderHttpFailure } from './provider-http.ts';
import { ProviderError, type Credential, type Resource } from './provider-types.ts';
import { linkedInOrganizationScopes } from './linkedin-scopes.ts';

export { linkedInOrganizationScopes } from './linkedin-scopes.ts';

function organizationFailure(failure: ProviderHttpFailure): ProviderError {
  if (failure.kind === 'network') return new ProviderError('LinkedIn company Pages could not be reached. Try again later.', 502);
  if (failure.kind === 'invalid-response') return new ProviderError('LinkedIn returned an invalid company Page response. Try again later.', 502);
  if (failure.status === 401) return new ProviderError('LinkedIn company Page access expired or was rejected. If you also use Campaign Manager with this developer app, enable Use LinkedIn Pages and Ads together in Check LinkedIn setup after confirming all listed permissions, then update permissions on both connections. Otherwise reconnect LinkedIn to renew access.', 401);
  if (failure.status === 403) return new ProviderError('LinkedIn denied company Page access. Confirm your developer app has approved organization permissions, reconnect LinkedIn, and use a member with Page super admin or content admin access.', 403);
  if (failure.status === 429) return new ProviderError('LinkedIn is rate limiting company Page requests. Try again later.', 429);
  return new ProviderError(`LinkedIn company Page discovery failed (HTTP ${failure.status}). Check the configured LinkedIn API version and app access.`, 502);
}

function companyHeaders(credential: Credential, env: NodeJS.ProcessEnv): Record<string, string> {
  if (env.LINKEDIN_ENABLE_ORGANIZATIONS !== 'true') {
    throw new ProviderError('Enable LinkedIn company Pages in Manage setup after your developer app receives organization API access, then reconnect LinkedIn.');
  }
  if (credential.fields?.scope !== undefined) {
    const granted = new Set(credential.fields.scope.split(/[\s,]+/).filter(Boolean));
    if (linkedInOrganizationScopes.some((scope) => !granted.has(scope))) {
      throw new ProviderError('This LinkedIn connection does not have the required company Page permissions. Confirm the app is approved for rw_organization_admin, r_organization_social and w_organization_social, then reconnect LinkedIn.', 403);
    }
  }
  const version = env.LINKEDIN_API_VERSION?.trim() || '202601';
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(version)) throw new ProviderError('Configure a supported LINKEDIN_API_VERSION in YYYYMM format.');
  return { authorization: `Bearer ${safeCredential(credential)}`, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' };
}

function name(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined;
}

function organizationName(body: JsonObject, organizationId: string): string {
  if (name(body.localizedName)) return name(body.localizedName)!;
  if (isObject(body.name) && isObject(body.name.localized)) {
    const locale = isObject(body.name.preferredLocale) ? body.name.preferredLocale : {};
    const preferred = name(body.name.localized[`${locale.language}_${locale.country}`]);
    if (preferred) return preferred;
    const localized = Object.values(body.name.localized).map(name).find(Boolean);
    if (localized) return localized;
  }
  return name(body.name) ?? `LinkedIn company Page ${organizationId}`;
}

/** Discover only Pages where the authenticated member has approved organic publishing access.
 * Paging links are never fetched: every request stays on the fixed official API origin.
 */
export async function listLinkedInOrganizations(credential: Credential, env: NodeJS.ProcessEnv): Promise<Resource[]> {
  const headers = companyHeaders(credential, env);
  const organizations = new Set<string>();
  let start = 0;
  for (let page = 0; page < 100; page++) {
    const url = new URL('https://api.linkedin.com/rest/organizationAcls');
    url.search = new URLSearchParams({ q: 'roleAssignee', state: 'APPROVED', start: String(start), count: '100' }).toString();
    const body = await fetchJson('LinkedIn', url.toString(), { headers }, { failure: organizationFailure });
    if (!Array.isArray(body.elements) || !body.elements.every(isObject)) {
      throw new ProviderError('LinkedIn returned invalid company Page permissions. Try again later.', 502);
    }
    for (const acl of body.elements) {
      // Organization ACL docs use CONTENT_ADMINISTRATOR; Posts API docs also use CONTENT_ADMIN.
      if (acl.state !== 'APPROVED' || !['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR', 'CONTENT_ADMIN'].includes(String(acl.role))) continue;
      // LinkedIn currently documents both field names across organization ACL response examples.
      const organization = acl.organization ?? acl.organizationTarget;
      if (typeof organization === 'string' && /^urn:li:organization:[1-9]\d{0,29}$/.test(organization)) organizations.add(organization);
    }
    const paging = isObject(body.paging) ? body.paging : {};
    const count = typeof paging.count === 'number' && Number.isSafeInteger(paging.count) && paging.count > 0 && paging.count <= 100 ? paging.count : 100;
    const total = typeof paging.total === 'number' && Number.isSafeInteger(paging.total) && paging.total >= 0 ? paging.total : undefined;
    const hasNext = total !== undefined ? start + count < total
      : Array.isArray(paging.links) ? paging.links.some((link) => isObject(link) && link.rel === 'next')
        : body.elements.length >= count;
    if (!hasNext) break;
    if (!body.elements.length || page === 99) {
      throw new ProviderError('LinkedIn company Page discovery could not finish pagination. Try again before selecting a Page.', 502);
    }
    start += count;
  }
  const resources: Resource[] = [];
  for (const urn of organizations) {
    const organizationId = urn.slice('urn:li:organization:'.length);
    const body = await fetchJson('LinkedIn', `https://api.linkedin.com/rest/organizations/${organizationId}`, { headers }, { failure: organizationFailure });
    const returnedId = typeof body.id === 'string' ? body.id
      : typeof body.id === 'number' && Number.isSafeInteger(body.id) && body.id > 0 ? String(body.id) : undefined;
    if (returnedId !== organizationId) throw new ProviderError('LinkedIn returned an invalid company Page identity. Try again later.', 502);
    resources.push({ id: urn, name: organizationName(body, organizationId), type: 'organization' });
  }
  return resources;
}
