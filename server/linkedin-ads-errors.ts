import type { ActionHttpFailure, ActionHttpOptions } from './action-http';
import { ProviderError } from './provider-types';

function linkedInAdsFailure({ status, code, errorCode }: ActionHttpFailure): ProviderError {
  const diagnostics = [`HTTP ${status}`, ...(code !== undefined ? [`provider code ${code}`] : []), ...(errorCode ? [errorCode] : [])].join('; ');
  if (status === 401) {
    return new ProviderError(`LinkedIn Ads access expired or was rejected (${diagnostics}). Reconnect LinkedIn Campaign Manager. If you also use LinkedIn Pages, enable Use LinkedIn Pages and Ads together and update permissions on both connections.`, 401);
  }
  if (status === 403) {
    return new ProviderError(`LinkedIn Ads denied this action (${diagnostics}). Check the app's approved Ads permissions and the signed-in member's access to this ad account.`, 403);
  }
  if (status === 429) {
    return new ProviderError(`LinkedIn Ads is rate limiting requests (${diagnostics}). Check the platform before retrying a write.`, 429);
  }
  if (status === 400 || errorCode === 'VERSION_MISSING' || errorCode === 'NONEXISTENT_VERSION') {
    return new ProviderError(`LinkedIn Ads rejected the request format or parameters (${diagnostics}). Check the LinkedIn API version and request parameters. This error alone does not establish a billing or account-permission problem. Check the platform before retrying a write.`, 400);
  }
  return new ProviderError(`LinkedIn Ads could not complete this action (${diagnostics}). Check the platform before retrying a write.`, 502);
}

/** Opt-in diagnostics for Ads actions only; other providers keep their current errors. */
export const linkedInAdsHttpOptions: ActionHttpOptions = {
  diagnosticFormat: 'linkedin-ads',
  failure: linkedInAdsFailure,
};
