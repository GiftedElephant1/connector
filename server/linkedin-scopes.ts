/** Pure scope definitions shared with the browser's consent preview. */
export const linkedInOrganizationScopes = ['rw_organization_admin', 'r_organization_social', 'w_organization_social'] as const;

export interface LinkedInScopeOptions {
  memberRead?: boolean;
  organizations?: boolean;
  conversions?: boolean;
  combined?: boolean;
}

export function linkedInScopeOptions(env: Record<string, string | undefined>): LinkedInScopeOptions {
  return {
    memberRead: env.LINKEDIN_ENABLE_MEMBER_READ === 'true',
    organizations: env.LINKEDIN_ENABLE_ORGANIZATIONS === 'true',
    conversions: env.LINKEDIN_ENABLE_CONVERSIONS === 'true',
    combined: env.LINKEDIN_COMBINE_SCOPES === 'true',
  };
}

/** LinkedIn invalidates earlier tokens when the same member/app consents to a different scope set. */
export function linkedInScopes(advertising: boolean, options: LinkedInScopeOptions = {}): string[] {
  const social = ['openid', 'profile', 'w_member_social', ...(options.memberRead ? ['r_member_social'] : []), ...(options.organizations ? linkedInOrganizationScopes : [])];
  const ads = ['r_ads', 'rw_ads', 'r_ads_reporting', ...(options.conversions ? ['rw_conversions'] : [])];
  // Opt-in only: a social-only app need not be approved for Advertising API.
  return options.combined ? [...social, ...ads] : advertising ? ads : social;
}
