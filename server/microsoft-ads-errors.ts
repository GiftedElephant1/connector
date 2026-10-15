import type { ProviderHttpFailure, ProviderHttpOptions } from './provider-http.ts';
import { ProviderError } from './provider-types.ts';

type MicrosoftStage = 'code-exchange' | 'token-refresh' | 'account-verification';
const setup = 'Settings → Platform application settings → Microsoft Advertising → Manage setup';
const stages: Record<MicrosoftStage, string> = {
  'code-exchange': 'authorization code exchange',
  'token-refresh': 'token refresh',
  'account-verification': 'account verification',
};

function advice(stage: MicrosoftStage, failure: ProviderHttpFailure): string {
  if (failure.status === 429) return 'Microsoft is rate limiting requests. Wait a minute before trying again.';
  if (stage === 'account-verification') {
    const credentials = `Check the production Microsoft Advertising developer token in ${setup}, then reconnect using the same work or personal identity that can open the advertising account. This message alone does not identify which credential Microsoft rejected.`;
    switch (failure.code) {
      case 105: return credentials;
      case 106: return 'The selected Microsoft Advertising user does not have permission for this request. Check that user’s access in Microsoft Advertising.';
      case 108: return 'Microsoft has restricted this user after detecting suspicious activity. Sign in directly to Microsoft and follow its account-recovery instructions.';
      case 109: return 'The Microsoft access token has expired. Start a fresh Connect account attempt.';
      case 116: return 'Microsoft reports a missing API header. Report this stage and code so the Connector request can be checked.';
      case 117: return 'Microsoft is rate limiting requests. Wait a minute before trying again.';
      case 120: return 'Microsoft Advertising rejected this sign-in identity. Sign in using the primary account associated with your Advertising account, then reconnect.';
      case 122:
      case 124:
      case 125: return 'Microsoft Advertising requires the work or school identity for this account. Reconnect and choose Work or school account.';
      case 123: return 'Microsoft Advertising requires the personal Microsoft identity for this account. Reconnect and choose Personal account.';
      case 126: return 'The sign-in identity type does not match the one registered with Microsoft Advertising. Use its registered identity type. Accounts that only support Google sign-in cannot authorize this Microsoft sign-in connection.';
      default: return failure.code === 0 || (failure.status ?? 0) >= 500
        ? 'Microsoft Advertising reported a service error. Wait a moment and try again; if it persists, report this stage and numeric code.'
        : credentials;
    }
  }
  switch (failure.code) {
    case 7000215: return `Microsoft rejected the application client secret. In ${setup}, save the secret Value from the same app registration as the client ID.`;
    case 7000222: return `The application client secret has expired. Create a new secret in that Entra app registration and save its Value in ${setup}.`;
    case 700016: return `Microsoft could not find this app registration. Compare the application client ID in ${setup} with the intended Entra registration and its supported account types.`;
    case 50011: return `The redirect URI does not match. Copy the exact redirect address from ${setup} into that Entra app registration’s Web redirect URIs.`;
    case 650052: return 'Microsoft Advertising API Service is not enabled for this tenant. Have its administrator check the service registration and Advertising access using Microsoft’s documented AADSTS650052 instructions, then reconnect.';
    case 65001: return 'Microsoft requires consent for this application’s Advertising access. Complete the permission prompt or obtain your tenant administrator’s approval, then reconnect.';
    case 50072:
    case 50076:
    case 50079: return 'Complete the required Microsoft sign-in and security-information registration for this account, then start a fresh Connect account attempt.';
  }
  switch (failure.oauthError) {
    case 'invalid_client': return `Microsoft rejected the app’s credentials. In ${setup}, check that the application client ID and unexpired client secret Value belong to the same Entra app registration.`;
    case 'invalid_grant': return 'Microsoft rejected the sign-in grant. Start a fresh Connect account attempt and finish its sign-in and consent prompts.';
    case 'interaction_required':
    case 'consent_required': return 'Microsoft needs an interactive sign-in or consent step. Complete its security and permission prompts, then reconnect.';
    case 'invalid_scope': return 'Microsoft rejected the Advertising permissions. Check the app’s delegated msads.manage permission and tenant consent, then reconnect.';
    case 'server_error':
    case 'temporarily_unavailable': return 'Microsoft reported a temporary sign-in service error. Wait a moment and try again.';
  }
  if ((failure.status ?? 0) >= 500) return 'Microsoft reported a sign-in service error. Wait a moment and try again.';
  if (stage === 'token-refresh') return 'Microsoft could not renew this connection. Start a fresh Connect account attempt and complete Microsoft sign-in.';
  return `Microsoft did not complete the token exchange. In ${setup}, check that the client ID and unexpired client secret Value belong to the same Entra app registration, then start a fresh Connect account attempt.`;
}

/** Only static guidance, bounded numbers and allowlisted OAuth codes reach the dashboard. */
export function microsoftAdsHttpOptions(stage: MicrosoftStage): ProviderHttpOptions {
  const identity = stage !== 'account-verification';
  return {
    diagnosticFormat: identity ? 'microsoft-identity' : 'microsoft-ads',
    failure(failure) {
      const label = `Microsoft Advertising ${stages[stage]}`;
      if (failure.kind === 'network') return new ProviderError(`${label} could not reach Microsoft. Check connectivity and try again.`, 502);
      if (failure.kind === 'invalid-response') return new ProviderError(`${label} returned an invalid response. Try again; if it persists, report this stage.`, 502);
      const details = [
        `HTTP ${failure.status}`,
        ...(failure.code !== undefined ? [`${identity ? 'AADSTS' : 'provider code'} ${failure.code}`] : []),
        ...(failure.oauthError ? [`OAuth ${failure.oauthError}`] : []),
      ].join('; ');
      const status = failure.status === 401 || failure.status === 403 || failure.status === 429 ? failure.status : 502;
      return new ProviderError(`${label} failed (${details}). ${advice(stage, failure)}`, status);
    },
  };
}
