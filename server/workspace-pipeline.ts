import { createHash } from 'node:crypto';
import { validateValues } from './actions';
import type { ActionAdapter, ActionResult } from './action-types';
import { ProviderError } from './provider-types';
import { Store } from './store';
import { WorkspaceAccounts } from './workspace-accounts';
import * as actions from './workspace-actions';

type ActionService = Pick<typeof actions, 'getWorkspaceAction' | 'listWorkspaceActions'>;
export interface WorkspaceReceipt {
  requestId: string;
  accountId: string;
  app: string;
  action: string;
  status: 'running' | 'succeeded' | 'failed' | 'uncertain';
  createdAt: string;
  finishedAt?: string;
  result?: ActionResult;
  error?: string;
}
interface StoredReceipt extends WorkspaceReceipt { fingerprint: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receiptKey = (profileId: string, requestId: string) => `workspace.receipt.v1.${digest([profileId, requestId])}`;
const safeError = (error: unknown) => error instanceof ProviderError ? error.message : 'The Google action could not be completed. Check Google before submitting it again.';
const publicReceipt = ({ fingerprint: _fingerprint, ...receipt }: StoredReceipt): WorkspaceReceipt => receipt;

/** Workspace records are deliberately separate from the legacy global job list. */
export class WorkspacePipeline {
  private readonly active = new Set<string>();
  constructor(private readonly store: Store, private readonly service: WorkspaceAccounts, private readonly env: NodeJS.ProcessEnv = process.env, private readonly adapters: ActionService = actions) {}

  accounts(profileId: string) {
    const profile = this.service.getAgent(profileId);
    if (!profile) throw new ProviderError('This AI profile is no longer available.', 403);
    return this.service.listAccounts().flatMap(account => {
      const binding = profile.bindings.find(item => item.accountId === account.id);
      if (!binding) return [];
      const permitted = binding.apps.filter(app => account.apps.includes(app));
      if (!permitted.length) return [];
      return [{ id: account.id, name: account.name, email: account.email, apps: permitted, status: account.status, isDefault: account.id === profile.defaultAccountId }];
    });
  }

  definitions(profileId: string, app: string, accountId?: string) {
    this.service.authorize(profileId, app, accountId);
    return this.adapters.listWorkspaceActions(app);
  }

  private action(app: string, id: string, input: unknown) {
    const adapter = this.adapters.getWorkspaceAction(app, id);
    if (!adapter) throw new ProviderError('This action is not supported by this Google app.', 404);
    return { adapter, values: validateValues(adapter, input) };
  }

  async run(profileId: string, app: string, id: string, input: unknown, confirmed?: unknown, requestId?: unknown, accountId?: string, assertCurrent: () => void = () => {}): Promise<{ result: ActionResult; receipt?: WorkspaceReceipt }> {
    assertCurrent();
    const account = this.service.authorize(profileId, app, accountId);
    const assertConnection = this.service.captureConnection(account.id, app);
    const { adapter, values } = this.action(app, id, input);
    // Refresh can wait on a network request. Re-read grants and the caller key
    // afterward so a dashboard revocation cannot race an outgoing action.
    const execute = async (action: ActionAdapter) => {
      const credential = await this.service.getCredential(account.id, app);
      assertCurrent();
      assertConnection();
      this.service.authorize(profileId, app, account.id);
      return action.execute(credential, values, this.env);
    };
    const mayReturn = () => {
      assertCurrent();
      assertConnection();
      this.service.authorize(profileId, app, account.id);
    };
    if (adapter.definition.kind === 'read') {
      const result = await execute(adapter);
      mayReturn();
      return { result };
    }
    if (confirmed !== true) throw new ProviderError('Explicit confirmation is required before sending or changing Google content.', 409);
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new ProviderError('Provide a unique requestId (8–128 letters, numbers, underscores or hyphens). Reuse it only for the same submission.');
    const key = receiptKey(profileId, requestId);
    const signature = digest([account.id, app, id, values]);
    const previous = this.store.readSetting<StoredReceipt>(key);
    if (previous) {
      if (previous.fingerprint !== signature) throw new ProviderError('This requestId was already used for a different Google submission.', 409);
      if (previous.status === 'succeeded' && previous.result) return { result: previous.result, receipt: publicReceipt(previous) };
      if (previous.status === 'running' && !this.active.has(key)) {
        previous.status = 'uncertain';
        previous.finishedAt = new Date().toISOString();
        previous.error = 'Connector stopped during this Google action. Check Google before submitting it again.';
        this.store.writeSetting(key, previous);
      }
      throw new ProviderError(`This Google submission is already ${previous.status}. Check Google before using another requestId.`, 409);
    }
    const receipt: StoredReceipt = { fingerprint: signature, requestId, accountId: account.id, app, action: id, status: 'running', createdAt: new Date().toISOString() };
    this.store.writeSetting(key, receipt);
    this.active.add(key);
    try {
      const result = await execute(adapter);
      receipt.status = 'succeeded';
      receipt.finishedAt = new Date().toISOString();
      receipt.result = result;
      this.store.writeSetting(key, receipt);
    } catch (error) {
      const rejected = error instanceof ProviderError && [400, 401, 403, 404, 409, 422, 429].includes(error.status);
      receipt.status = rejected ? 'failed' : 'uncertain';
      receipt.finishedAt = new Date().toISOString();
      receipt.error = safeError(error);
      this.store.writeSetting(key, receipt);
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(receipt.error, 502);
    } finally {
      this.active.delete(key);
    }
    mayReturn();
    return { result: receipt.result!, receipt: publicReceipt(receipt) };
  }
}
