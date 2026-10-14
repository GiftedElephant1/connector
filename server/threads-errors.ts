import type { ProviderHttpFailure, ProviderHttpOptions } from './provider-http.ts';
import { ProviderError } from './provider-types.ts';

type ThreadsStage = 'code-exchange' | 'token-extension' | 'profile-verification' | 'token-refresh';

const stages: Record<ThreadsStage, { label: string; guidance: string }> = {
  'code-exchange': {
    label: 'authorization code exchange',
    guidance: 'Start a fresh Connect account attempt; sign-in codes can expire or be used only once.',
  },
  'token-extension': {
    label: 'long-lived token exchange',
    guidance: 'The sign-in code was accepted, but Threads did not finish granting long-lived access. Start a fresh Connect account attempt.',
  },
  'profile-verification': {
    label: 'profile verification',
    guidance: 'Threads did not verify the profile for this token. Check the selected Threads profile and app permissions, then reconnect.',
  },
  'token-refresh': {
    label: 'token refresh',
    guidance: 'Threads did not renew this connection. Reconnect the account to renew access.',
  },
};

function failureMessage(stage: ThreadsStage, failure: ProviderHttpFailure): ProviderError {
  const { label, guidance } = stages[stage];
  if (failure.kind === 'network') {
    return new ProviderError(`Threads ${label} could not reach the API. Check connectivity and try again.`, 502);
  }
  if (failure.kind === 'invalid-response') {
    return new ProviderError(`Threads ${label} returned an invalid response. Try again; if it persists, report this stage.`, 502);
  }
  const details = [
    `HTTP ${failure.status}`,
    ...(failure.code !== undefined ? [`provider code ${failure.code}`] : []),
    ...(failure.subcode !== undefined ? [`subcode ${failure.subcode}`] : []),
  ].join('; ');
  const status = failure.status === 401 || failure.status === 403 || failure.status === 429 ? failure.status : 502;
  const advice = failure.status === 429 ? 'Threads is rate limiting requests. Try again later.' : guidance;
  return new ProviderError(`Threads ${label} failed (${details}). ${advice} If it persists, share this stage and numeric codes only.`, status);
}

/** Static stage names plus numeric metadata only; never copy provider-supplied text into feedback. */
export function threadsHttpOptions(stage: ThreadsStage): ProviderHttpOptions {
  return { failure: (failure) => failureMessage(stage, failure) };
}
