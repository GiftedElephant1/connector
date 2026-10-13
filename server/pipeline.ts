import { createHash } from 'node:crypto';
import type { ActionAdapter, ActionResult, ActionValues } from './action-types';
import { Store, type Job } from './store';
import * as providers from './providers';
import * as actions from './actions';
import { ProviderError } from './provider-types';

type ActionService = Pick<typeof actions, 'getAction' | 'listActions' | 'validateValues'>;
type CredentialService = Pick<typeof providers, 'refreshCredential'>;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeMessage = (error: unknown) => error instanceof ProviderError ? error.message : 'The action could not be completed. Check the platform before submitting it again.';

export class Pipeline {
  constructor(private store: Store, private env: NodeJS.ProcessEnv = process.env, private service: ActionService = actions, private credentials: CredentialService = providers) {}
  definitions(provider: string) { return this.service.listActions(provider); }
  jobs() { return this.store.jobs(); }
  private validated(provider: string, id: string, input: unknown) {
    const action = this.service.getAction(provider, id);
    return { action, values: this.service.validateValues(action, input) };
  }
  private async execute(provider: string, action: ActionAdapter, values: ActionValues, assertCurrent: () => void = () => {}): Promise<ActionResult> {
    let credential = this.store.credential(provider);
    if (!credential) throw new ProviderError('Connect this platform before running an action.', 409);
    if (credential.expiresAt && credential.expiresAt <= Date.now() + 60_000) {
      credential = await this.credentials.refreshCredential(provider, credential, this.env);
      this.store.updateCredential(provider, credential);
    }
    // OAuth consent can be revoked while a platform refresh is in flight.
    assertCurrent();
    return action.execute(credential, values, this.env);
  }
  private requestId(input: unknown): string {
    if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input)) throw new ProviderError('Provide a unique requestId (8–128 letters, numbers, underscores or hyphens). Reuse it only to retry the same submission.');
    return input;
  }
  async run(provider: string, id: string, input: unknown, confirmed: unknown, requestId?: unknown, assertCurrent: () => void = () => {}): Promise<{ result: ActionResult; job?: Job }> {
    assertCurrent();
    const { action, values } = this.validated(provider, id, input);
    if (action.definition.kind === 'read') {
      const result = await this.execute(provider, action, values, assertCurrent);
      assertCurrent();
      return { result };
    }
    if (confirmed !== true) throw new ProviderError('Explicit confirmation is required before publishing, replying, changing campaigns, or uploading conversions.', 409);
    const key = this.requestId(requestId);
    const signature = fingerprint([provider, id, values, 'immediate']);
    const previous = this.store.job(key);
    if (previous) {
      if (this.store.jobFingerprint(key) !== signature) throw new ProviderError('This requestId was already used for a different submission.', 409);
      if (previous.status === 'succeeded' && previous.result) return { result: previous.result, job: previous };
      throw new ProviderError(`This submission is already ${previous.status}. Check its job and the platform before creating another requestId.`, 409);
    }
    if (!this.store.credential(provider)) throw new ProviderError('Connect this platform before running an action.', 409);
    this.store.createJob(key, signature, provider, id, values, Date.now());
    const job = await this.runJob(key, assertCurrent);
    assertCurrent();
    if (job.status !== 'succeeded' || !job.result) throw new ProviderError(job.error || 'The action did not complete.', job.status === 'uncertain' ? 502 : 400);
    return { result: job.result, job };
  }
  schedule(provider: string, id: string, input: unknown, scheduledAt: unknown, confirmed: unknown, requestId: unknown): Job {
    const { action, values } = this.validated(provider, id, input);
    if (!action.definition.schedulable || action.definition.kind !== 'write') throw new ProviderError('Only supported publication actions can be scheduled.');
    if (confirmed !== true) throw new ProviderError('Confirm this scheduled publication before saving it.', 409);
    if (!this.store.credential(provider)) throw new ProviderError('Connect this platform before scheduling a post.', 409);
    if (typeof scheduledAt !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(scheduledAt)) throw new ProviderError('scheduledAt must be a date and time with a timezone.');
    const scheduled = Date.parse(scheduledAt);
    if (!Number.isFinite(scheduled)) throw new ProviderError('scheduledAt must be a valid date.');
    const key = this.requestId(requestId);
    const signature = fingerprint([provider, id, values, scheduled]);
    const previous = this.store.job(key);
    if (previous) {
      if (this.store.jobFingerprint(key) !== signature) throw new ProviderError('This requestId was already used for a different submission.', 409);
      return previous;
    }
    if (scheduled < Date.now() + 5000 || scheduled > Date.now() + 366 * 24 * 60 * 60 * 1000) throw new ProviderError('Schedule posts at least 5 seconds and at most one year in the future.');
    return this.store.createJob(key, signature, provider, id, values, scheduled);
  }
  cancel(id: string): Job {
    if (!this.store.cancelJob(id)) throw new ProviderError('Only a pending job can be cancelled.', 409);
    return this.store.job(id)!;
  }
  private async runJob(id: string, assertCurrent: () => void = () => {}): Promise<Job> {
    if (!this.store.claimJob(id)) return this.store.job(id)!;
    const job = this.store.job(id)!;
    try {
      const action = this.service.getAction(job.provider, job.action);
      const values = this.service.validateValues(action, this.store.jobValues(id));
      const result = await this.execute(job.provider, action, values, assertCurrent);
      this.store.finishJob(id, 'succeeded', result);
    } catch (error) {
      const clearlyRejected = error instanceof ProviderError && [400, 401, 403, 404, 409, 422, 429].includes(error.status);
      this.store.finishJob(id, clearlyRejected ? 'failed' : 'uncertain', undefined, safeMessage(error));
    }
    return this.store.job(id)!;
  }
  startScheduler(): () => Promise<void> {
    this.store.recoverJobs();
    let stopping = false;
    let current: Promise<void> | undefined;
    const tick = async () => {
      if (stopping || current) return;
      const run = async () => {
        for (const job of this.store.dueJobs()) { if (stopping) break; await this.runJob(job.id); }
      };
      current = run();
      try { await current; } finally { current = undefined; }
    };
    const timer = setInterval(() => { void tick(); }, 15_000);
    timer.unref();
    void tick();
    return async () => { stopping = true; clearInterval(timer); await current; };
  }
}
