/** One canonical callback per authorization flow, including provider-required slashes. */
export function oauthCallbackUrl(origin: string, provider: string): string {
  return `${origin}/api/oauth/${provider}/callback${provider === 'tiktok-business-account' ? '/' : ''}`;
}
