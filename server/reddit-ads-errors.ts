import type { ProviderHttpFailure, ProviderHttpOptions } from './provider-http.ts';
import { ProviderError } from './provider-types.ts';

type RedditAdsStage = 'code-exchange' | 'token-refresh' | 'account-verification';
const setup = 'Settings → Platform application settings → Reddit Ads → Manage setup';
const stages: Record<RedditAdsStage, string> = {
  'code-exchange': 'authorization code exchange',
  'token-refresh': 'token refresh',
  'account-verification': 'account verification',
};

function advice(stage: RedditAdsStage, failure: ProviderHttpFailure): string {
  if (failure.status === 429) return 'Reddit is rate limiting requests. Wait a moment before trying again.';
  if ((failure.status ?? 0) >= 500 || failure.oauthError === 'server_error' || failure.oauthError === 'temporarily_unavailable') {
    return 'Reddit reported a temporary service error. Wait a moment and try again.';
  }
  if (stage === 'account-verification') {
    if (failure.status === 401) {
      return `Reddit Ads rejected the access token. Start a fresh Connect account attempt. Also confirm the Reddit Ads account ID in ${setup} and that the Reddit user you authorize has access to that ad account.`;
    }
    if (failure.status === 403) {
      return 'Check that the authorized Reddit user can access this ad account and that the app requests adsread and adsedit. Reconnect and grant the requested advertising permissions.';
    }
    if (failure.status === 404) return `Check the Reddit Ads account ID in ${setup}. Use the ad account identifier, not the business ID or app client ID, and authorize a user with access to that ad account.`;
    return `Reddit Ads could not verify the selected ad account. Check its account ID in ${setup} and the authorized user’s access. If it persists, report this stage and code.`;
  }
  switch (failure.oauthError) {
    case 'invalid_client': return `Reddit rejected the app’s credentials. In ${setup}, check that the client ID and generated client secret belong to the same Reddit Ads developer application.`;
    case 'invalid_grant': return stage === 'token-refresh'
      ? 'Reddit rejected the saved refresh grant. Start a fresh Connect account attempt and approve access again.'
      : `Reddit rejected the authorization grant. Start a fresh Connect account attempt. If it persists, confirm the exact redirect address from ${setup} is registered in that Reddit Ads app.`;
    case 'invalid_scope': return 'Reddit rejected the requested permissions. Check that this is the Reddit Ads developer application and that adsread and adsedit are supported, then reconnect.';
    case 'access_denied':
    case 'consent_required':
    case 'interaction_required': return 'Reddit requires a new sign-in or permission approval. Start a fresh Connect account attempt and complete the Reddit prompts.';
    case 'unauthorized_client': return 'Reddit did not allow this app to use the requested authorization flow. Check that Connector is configured with your Reddit Ads developer application, then reconnect.';
  }
  if (failure.status === 401) {
    return `Check that the client ID and generated client secret in ${setup} belong to the same Reddit Ads developer application. This response alone does not identify which value Reddit rejected.`;
  }
  if (failure.status === 403) return 'Reddit denied the token request. Check this Reddit Ads app’s permissions and the authorizing user’s access, then start a fresh Connect account attempt.';
  if (stage === 'token-refresh') return 'Reddit could not renew this connection. Start a fresh Connect account attempt and approve access again.';
  return `Reddit did not complete the token exchange. Check the Reddit Ads app’s client ID, generated secret, and exact redirect address in ${setup}, then start a fresh Connect account attempt.`;
}

/** Expose only the request stage, bounded numeric codes and allowlisted OAuth errors. */
export function redditAdsHttpOptions(stage: RedditAdsStage): ProviderHttpOptions {
  const tokenStage = stage !== 'account-verification';
  return {
    ...(tokenStage ? { diagnosticFormat: 'oauth' as const } : {}),
    failure(failure) {
      const label = `Reddit Ads ${stages[stage]}`;
      if (failure.kind === 'network') return new ProviderError(`${label} could not reach Reddit. Check connectivity and try again.`, 502);
      if (failure.kind === 'invalid-response') {
        const status = failure.status === undefined ? '' : ` (HTTP ${failure.status})`;
        return new ProviderError(`${label} returned an invalid response${status}. Try again; if it persists, report this stage.`, 502);
      }
      const details = [
        `HTTP ${failure.status}`,
        ...(!tokenStage && failure.code !== undefined ? [`provider code ${failure.code}`] : []),
        ...(tokenStage && failure.oauthError ? [`OAuth ${failure.oauthError}`] : []),
      ].join('; ');
      const status = failure.status === 401 || failure.status === 403 || failure.status === 429 ? failure.status : 502;
      return new ProviderError(`${label} failed (${details}). ${advice(stage, failure)}`, status);
    },
  };
}
