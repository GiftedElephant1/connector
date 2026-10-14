const genericAuthorizationError = 'Authorization was declined or could not be completed. Please connect again.';

/** Map only known provider codes; descriptions and other callback values are untrusted. */
export function oauthAuthorizationError(provider: string, error: unknown): string {
  if (provider !== 'linkedin' && provider !== 'linkedin-ads') return genericAuthorizationError;
  const setup = provider === 'linkedin' ? 'Connections → LinkedIn → Check LinkedIn setup' : 'Connections → LinkedIn Campaign Manager → Check LinkedIn setup';
  const fallback = `LinkedIn authorization could not be completed. Open ${setup}, check the app settings and approved products, then connect again.`;
  if (typeof error !== 'string') return fallback;
  switch (error) {
    case 'unauthorized_scope_error':
    case 'invalid_scope':
      return provider === 'linkedin'
        ? `LinkedIn rejected the requested permissions. Open ${setup}. The developer app needs Sign In with LinkedIn using OpenID Connect for openid and profile, plus Share on LinkedIn for w_member_social. Confirm these scopes appear in its Auth tab. Keep r_member_social disabled unless LinkedIn has approved it, then connect again.`
        : `LinkedIn rejected the requested advertising permissions. Open ${setup}. The LinkedIn developer app needs approved Advertising API access. Enable rw_conversions only after Conversions API access is approved, then connect again.`;
    case 'user_cancelled_login':
    case 'user_cancelled_authorize':
      return 'LinkedIn sign-in or authorization was cancelled. Connect again and complete LinkedIn sign-in and the permission screen.';
    case 'access_denied':
      return `LinkedIn did not grant access. Connect again and complete the permission screen. If access is still denied, open ${setup} and check the app's approved products and permissions.`;
    case 'invalid_client_id':
    case 'invalid_client':
      return `LinkedIn did not recognize the developer app. Open ${setup} and compare the saved Client ID with the Auth tab of the same LinkedIn developer app. Save the correct value, then connect again.`;
    case 'invalid_redirect_uri':
      return `LinkedIn rejected the callback address. Open ${setup}, copy this connector's exact OAuth redirect URL, and save it in the LinkedIn developer app's Auth tab under Authorized redirect URLs for your app. Then connect again.`;
    case 'invalid_request':
      return `LinkedIn rejected the authorization request. Open ${setup}, check the Client ID, exact callback address and approved products, then start a new connection attempt.`;
    case 'server_error':
    case 'temporarily_unavailable':
      return 'LinkedIn reported a temporary authorization error. Wait a moment, then start a new connection attempt.';
    default:
      return fallback;
  }
}
