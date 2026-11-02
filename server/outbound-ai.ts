import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { Store, hash } from './store';
import { ProviderError } from './provider-types';
import { checkLocal, runLocal, type LocalProvider } from './outbound-local';
import { CursorOutboundAdapter } from './outbound-cursor';
import { startGrok, validateGrokConfig } from './outbound-grok';
import { outboundNames, outboundProviders, type AiTask, type OutboundProvider, type OutboundProviderConfig, type OutboundSettings, type StoredAiTask, type OutboundProviderView } from './outbound-types';

const SETTING = 'outbound-ai-v1';
const settingsSchema = z.object({
  enabled: z.boolean(), executable: z.string().max(2048).optional(), apiKey: z.string().max(4096).optional(),
  model: z.string().max(200).optional(), webhookUrl: z.string().max(4096).optional(), webhookKey: z.string().max(4096).optional(),
}).strict();
const startSchema = z.object({ provider: z.enum(outboundProviders), prompt: z.string().min(1).max(16000), confirmed: z.literal(true), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) }).strict();
const isLocal = (provider: OutboundProvider): provider is LocalProvider => ['claude', 'chatgpt', 'gemini'].includes(provider);
const safeError = (error: unknown) => error instanceof ProviderError ? error.message : 'The AI task could not be verified. Check the provider before submitting it again.';
const publicTask = ({ principal: _principal, fingerprint: _fingerprint, remoteId: _remoteId, configGeneration: _generation, ...task }: StoredAiTask): AiTask => task;
const boundedResult = (result: string | undefined) => result && result.length > 100_000 ? `${result.slice(0, 100_000)}\n[Result truncated at 100,000 characters.]` : result;

export interface OutboundDependencies {
  localCheck?: typeof checkLocal;
  localRun?: typeof runLocal;
  cursor?: Pick<CursorOutboundAdapter, 'models' | 'start' | 'poll' | 'cancel'>;
  grokStart?: typeof startGrok;
}

/** Owner-configured task delegation. Provider credentials never leave this service. */
export class OutboundAI {
  private readonly localCheck: typeof checkLocal;
  private readonly localRun: typeof runLocal;
  private readonly cursor: Pick<CursorOutboundAdapter, 'models' | 'start' | 'poll' | 'cancel'>;
  private readonly grokStart: typeof startGrok;
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly polling = new Map<string, Promise<void>>();
  private readonly cancelling = new Map<string, Promise<AiTask>>();
  private closing = false;
  private readonly workspaces: string;

  constructor(private readonly store: Store, databasePath: string, deps: OutboundDependencies = {}) {
    this.localCheck = deps.localCheck || checkLocal;
    this.localRun = deps.localRun || runLocal;
    this.cursor = deps.cursor || new CursorOutboundAdapter();
    this.grokStart = deps.grokStart || startGrok;
    this.workspaces = databasePath === ':memory:' ? join(tmpdir(), `connector-ai-${randomUUID()}`) : join(dirname(databasePath), 'ai-workspaces');
    // Never replay a submission after a crash. A known remote Cursor run can be read again.
    for (const task of this.store.aiTasks<StoredAiTask>()) {
      if (task.status === 'running' && !(task.provider === 'cursor' && task.remoteId)) {
        this.saveTask({ ...task, status: 'uncertain', error: 'Connector restarted while this task was running. Check the provider before starting another task.' });
      }
    }
  }

  private settings(): OutboundSettings { return this.store.readSetting<OutboundSettings>(SETTING) || { allowSharedKey: false, providers: {} }; }
  private provider(value: string): OutboundProvider {
    if (!outboundProviders.includes(value as OutboundProvider)) throw new ProviderError('Choose a supported outbound AI agent.', 404);
    return value as OutboundProvider;
  }
  private configured(provider: OutboundProvider, config?: OutboundProviderConfig): boolean {
    return !!config && (isLocal(provider) || (provider === 'cursor' ? !!config.apiKey && !!config.model : !!config.webhookUrl && !!config.webhookKey));
  }
  private view(provider: OutboundProvider): OutboundProviderView {
    const config = this.settings().providers[provider];
    return { id: provider, name: outboundNames[provider], enabled: !!config?.enabled, configured: this.configured(provider, config),
      ...(isLocal(provider) ? { executable: config?.executable || '' } : {}),
      ...(provider === 'cursor' ? { model: config?.model || '', hasApiKey: !!config?.apiKey } : {}),
      ...(provider === 'grok' ? { hasWebhookUrl: !!config?.webhookUrl, hasWebhookKey: !!config?.webhookKey } : {}),
      ...(config?.check ? { check: config.check } : {}),
    };
  }
  snapshot() { return { allowSharedKey: this.settings().allowSharedKey, providers: outboundProviders.map(provider => this.view(provider)), tasks: this.listTasks('owner') }; }
  access(input: unknown) {
    const parsed = z.object({ allowSharedKey: z.boolean() }).strict().safeParse(input);
    if (!parsed.success) throw new ProviderError('Choose whether the shared Connector key may delegate AI tasks.');
    this.store.writeSetting(SETTING, { ...this.settings(), allowSharedKey: parsed.data.allowSharedKey });
    return { allowSharedKey: parsed.data.allowSharedKey };
  }
  configure(value: string, input: unknown) {
    const provider = this.provider(value);
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) throw new ProviderError('The AI setup fields are invalid.');
    const allowed = isLocal(provider) ? ['enabled', 'executable'] : provider === 'cursor' ? ['enabled', 'apiKey', 'model'] : ['enabled', 'webhookUrl', 'webhookKey'];
    if (Object.keys(parsed.data).some(key => !allowed.includes(key))) throw new ProviderError('These settings do not belong to this AI agent.');
    const settings = this.settings();
    const old = settings.providers[provider];
    const next: OutboundProviderConfig = { ...old, enabled: parsed.data.enabled, generation: old?.generation || randomUUID() };
    for (const [key, raw] of Object.entries(parsed.data)) {
      if (key === 'enabled' || typeof raw !== 'string') continue;
      const value = raw.trim();
      if (/[\r\n\0]/.test(value)) throw new ProviderError('Enter a single value in each setup field.');
      if (['apiKey', 'webhookUrl', 'webhookKey'].includes(key) && !value) continue; // Blank secret inputs retain encrypted saved values.
      (next as unknown as Record<string, unknown>)[key] = value || undefined;
    }
    if (next.executable && !isAbsolute(next.executable)) throw new ProviderError('Use the full path to the official executable, or leave it blank for automatic discovery.');
    if (provider === 'grok' && next.webhookUrl && next.webhookKey) validateGrokConfig({ webhookUrl: next.webhookUrl, webhookKey: next.webhookKey });
    if (next.enabled && !this.configured(provider, next)) throw new ProviderError('Complete this agent’s setup before enabling outbound tasks.');
    const credentialsChanged = ['apiKey', 'webhookUrl', 'webhookKey', 'executable'].some(key => next[key as keyof OutboundProviderConfig] !== old?.[key as keyof OutboundProviderConfig]);
    if (credentialsChanged) next.generation = randomUUID();
    if (credentialsChanged || next.model !== old?.model) delete next.check;
    settings.providers[provider] = next;
    this.store.writeSetting(SETTING, settings);
    if (provider === 'cursor' && credentialsChanged && old) {
      for (const task of this.store.aiTasks<StoredAiTask>()) {
        if (task.provider === 'cursor' && task.status === 'running' && task.configGeneration === old.generation) {
          this.saveTask({ ...task, status: 'uncertain', error: 'Cursor credentials changed after this task started. Manage this task in the original Cursor account; changing credentials does not stop it.' });
        }
      }
    }
    return { provider: this.view(provider) };
  }
  async cursorModels(input: unknown) {
    const parsed = z.object({ apiKey: z.string().max(4096).optional() }).strict().safeParse(input);
    if (!parsed.success) throw new ProviderError('Enter a valid Cursor API key.');
    const apiKey = parsed.data.apiKey?.trim() || this.settings().providers.cursor?.apiKey;
    if (!apiKey || /[\r\n\0]/.test(apiKey)) throw new ProviderError('Save or enter your Cursor API key first.');
    return { models: await this.cursor.models({ apiKey, model: '' }) };
  }
  async check(value: string) {
    const provider = this.provider(value);
    const config = this.settings().providers[provider];
    if (!config || !this.configured(provider, config)) throw new ProviderError('Save this agent’s setup first.', 409);
    let check: NonNullable<OutboundProviderConfig['check']>;
    const checkedAt = new Date().toISOString();
    try {
      if (isLocal(provider)) {
        const result = await this.localCheck(provider, { executable: config.executable });
        check = { status: result.status === 'ready' || result.status === 'unverified' ? 'ready' : result.available ? 'action_required' : 'unavailable', message: result.message, checkedAt };
      } else if (provider === 'cursor') {
        const models = await this.cursor.models({ apiKey: config.apiKey!, model: config.model! });
        const available = models.some(item => item.id === config.model && item.subscriptionEligible);
        check = { status: available ? 'ready' : 'action_required', message: available ? 'Cursor accepted the key and lists the selected included model. A task has not been started; account limits still apply.' : 'Choose an available model covered by the Cursor subscription.', checkedAt };
      } else {
        validateGrokConfig({ webhookUrl: config.webhookUrl, webhookKey: config.webhookKey });
        check = { status: 'ready', message: 'Webhook settings are valid in format; the URL and key have not been verified by Grok Bot. Sending a task is the acceptance test and uses your Bot allowance. Results appear in Grok Bot.', checkedAt };
      }
    } catch (error) {
      check = { status: 'action_required', message: error instanceof ProviderError ? error.message : 'The agent’s setup could not be checked. Review its installation and sign-in on the Connector PC.', checkedAt };
    }
    const settings = this.settings();
    if (settings.providers[provider]?.generation === config.generation) {
      settings.providers[provider]!.check = check;
      this.store.writeSetting(SETTING, settings);
    }
    return { provider: this.view(provider) };
  }
  async checkForAgent(value: string, principal: string) {
    this.assertPrincipal(principal);
    const provider = this.provider(value);
    if (!this.settings().providers[provider]?.enabled) throw new ProviderError('The owner must enable this outbound AI agent before it can be checked.', 409);
    const result = await this.check(provider);
    this.assertPrincipal(principal);
    return { provider, name: result.provider.name, enabled: result.provider.enabled, check: result.provider.check };
  }
  private assertPrincipal(principal: string) {
    if (principal.startsWith('key:') && !this.settings().allowSharedKey) throw new ProviderError('The owner must enable AI delegation for the shared Connector key in AI connections → Send tasks to AI agents.', 403);
  }
  agents(principal: string) {
    const allowed = !principal.startsWith('key:') || this.settings().allowSharedKey;
    return { delegationAllowed: allowed, agents: outboundProviders.map(provider => {
      const config = this.settings().providers[provider];
      return { provider, name: outboundNames[provider], enabled: !!config?.enabled && allowed, configured: this.configured(provider, config),
        mode: isLocal(provider) ? 'local_text_task' : provider === 'cursor' ? 'cloud_agent' : 'routine_webhook',
        returnsResult: provider !== 'grok', canCancel: provider !== 'grok',
        ...(config?.check ? { check: config.check } : {}),
        note: provider === 'grok' ? 'Starts the configured routine. Acceptance is not completion; read the result in Grok Bot.' : isLocal(provider) ? 'Uses the official signed-in agent on the owner’s PC. Text tasks only; no Connector keys or platform tools are forwarded.' : 'Starts an isolated no-repository Cursor Cloud Agent using the configured included model. No Connector credentials are forwarded.',
      };
    }) };
  }
  private task(id: string, principal: string): StoredAiTask {
    this.assertPrincipal(principal);
    const task = /^[a-f0-9]{64}$/.test(id) && this.store.readAiTask<StoredAiTask>(id);
    if (!task || (principal !== 'owner' && task.principal !== principal)) throw new ProviderError('This AI task is not available to this connection.', 404);
    return task;
  }
  assertTaskProvider(id: string, principal: string, provider: OutboundProvider): void {
    if (this.task(id, principal).provider !== provider) throw new ProviderError('This task belongs to a different AI destination.', 404);
  }
  listTasks(principal: string) {
    this.assertPrincipal(principal);
    return this.store.aiTasks<StoredAiTask>().filter(task => principal === 'owner' || task.principal === principal).slice(0, 100).map(publicTask);
  }
  start(principal: string, input: unknown, assertCurrent: () => void = () => {}): AiTask {
    this.assertPrincipal(principal); assertCurrent();
    if (this.closing) throw new ProviderError('Connector is stopping. Wait until it restarts.', 409);
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) throw new ProviderError('Approve the exact AI task, choose an agent, and supply a prompt of 1–16,000 characters and a unique requestId of 8–128 letters, digits, underscores or hyphens.', 400);
    const { provider, prompt, requestId } = parsed.data;
    if (!prompt.trim()) throw new ProviderError('Enter a task prompt.');
    const id = hash(`${principal}\0${requestId}`);
    const fingerprint = hash(JSON.stringify({ provider, prompt }));
    const previous = this.store.readAiTask<StoredAiTask>(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ProviderError('This requestId already belongs to a different task. Use the original task details when retrying.', 409);
      return publicTask(previous);
    }
    const config = this.settings().providers[provider];
    if (!config?.enabled || !this.configured(provider, config)) throw new ProviderError('The owner must enable and configure this outbound AI agent first.', 409);
    const active = this.store.aiTasks<StoredAiTask>().filter(task => task.status === 'running' || this.running.has(task.id));
    if (active.length >= 3 || active.some(task => task.provider === provider)) throw new ProviderError('An AI task is already starting or running for this agent, or three agents are active. Check the active task status before starting another.', 429);
    const now = new Date().toISOString();
    const task: StoredAiTask = { id, provider, prompt, fingerprint, principal, status: 'running', createdAt: now, updatedAt: now, configGeneration: config.generation };
    this.store.saveAiTask(id, task);
    const controller = new AbortController();
    // Persist the receipt before the first external call, and return immediately.
    const done = Promise.resolve().then(() => { assertCurrent(); return this.execute(task, config, controller.signal); }).catch(error => {
      this.saveTask({ ...task, status: 'uncertain', error: safeError(error) });
    }).finally(() => { this.running.delete(id); });
    this.running.set(id, { controller, done });
    return publicTask(task);
  }
  private saveTask(task: StoredAiTask) {
    this.store.saveAiTask(task.id, { ...task, result: boundedResult(task.result), updatedAt: new Date().toISOString() });
  }
  private async execute(task: StoredAiTask, config: OutboundProviderConfig, signal: AbortSignal) {
    const workspace = join(this.workspaces, task.id);
    try {
      if (isLocal(task.provider)) {
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        const result = await this.localRun(task.provider, { executable: config.executable }, task.prompt, { cwd: workspace, signal });
        this.saveTask({ ...task, status: 'succeeded', result: result.result });
      } else if (task.provider === 'cursor') {
        const result = await this.cursor.start({ apiKey: config.apiKey!, model: config.model! }, task.prompt, signal);
        this.saveTask({ ...task, ...result });
      } else {
        const result = await this.grokStart({ webhookUrl: config.webhookUrl!, webhookKey: config.webhookKey! }, task.prompt, task.id, signal);
        this.saveTask({ ...task, ...result });
      }
    } catch (error) {
      const rejected = error instanceof ProviderError && [400, 401, 403, 404, 422, 429].includes(error.status);
      const cancelled = isLocal(task.provider) && signal.aborted && error instanceof ProviderError && error.status === 409;
      this.saveTask({ ...task, status: cancelled ? 'cancelled' : rejected ? 'failed' : 'uncertain', error: safeError(error) });
    } finally {
      if (isLocal(task.provider)) await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
  async get(id: string, principal: string): Promise<AiTask> {
    const task = this.task(id, principal);
    if (task.provider === 'cursor' && task.remoteId && ['running', 'uncertain'].includes(task.status) && !this.running.has(id)) {
      if (!this.polling.has(id)) {
        this.polling.set(id, this.pollCursor(task).finally(() => { this.polling.delete(id); }));
      }
      await this.polling.get(id);
    }
    return publicTask(this.task(id, principal));
  }
  private async pollCursor(task: StoredAiTask) {
    const config = this.settings().providers.cursor;
    if (!config?.apiKey || config.generation !== task.configGeneration) {
      // Never send a run to a newly configured account.
      this.saveTask({ ...task, status: 'uncertain', error: 'Cursor setup changed after this task started. Review the task in the original Cursor account.' });
      return;
    }
    try {
      const result = await this.cursor.poll({ apiKey: config.apiKey, model: config.model! }, task.remoteId!);
      const latest = this.store.readAiTask<StoredAiTask>(task.id)!;
      if (['running', 'uncertain'].includes(latest.status)) this.saveTask({ ...latest, error: undefined, ...result });
    } catch (error) {
      const latest = this.store.readAiTask<StoredAiTask>(task.id)!;
      if (['running', 'uncertain'].includes(latest.status)) this.saveTask({ ...latest, error: safeError(error) });
    }
  }
  async cancel(id: string, principal: string, confirmed: unknown, assertCurrent: () => void = () => {}): Promise<AiTask> {
    this.task(id, principal); assertCurrent();
    if (confirmed !== true) throw new ProviderError('Confirm cancellation of this AI task first.', 409);
    const existing = this.cancelling.get(id);
    if (existing) return existing;
    const done = this.cancelTask(id, principal, assertCurrent).finally(() => { this.cancelling.delete(id); });
    this.cancelling.set(id, done);
    return done;
  }
  private async cancelTask(id: string, principal: string, assertCurrent: () => void): Promise<AiTask> {
    let task = this.task(id, principal);
    if (task.provider === 'grok') throw new ProviderError('An accepted routine cannot be stopped through its webhook. Open Grok Bot to manage the routine.', 409);
    if (!['running', 'uncertain'].includes(task.status)) return publicTask(task);
    const running = this.running.get(id);
    if (running) {
      if (task.provider === 'cursor') await running.done; // First learn the remote run ID; aborting the HTTP call would lose it.
      else { running.controller.abort(); await running.done; return publicTask(this.task(id, principal)); }
    }
    if (this.polling.has(id)) await this.polling.get(id);
    task = this.task(id, principal); assertCurrent();
    if (!['running', 'uncertain'].includes(task.status)) return publicTask(task);
    if (task.provider === 'cursor' && task.remoteId) {
      const config = this.settings().providers.cursor;
      if (!config?.apiKey || config.generation !== task.configGeneration) throw new ProviderError('Cursor setup changed. Manage this task in Cursor directly.', 409);
      const result = await this.cursor.cancel({ apiKey: config.apiKey, model: config.model! }, task.remoteId);
      this.saveTask({ ...task, error: undefined, ...result });
      return publicTask(this.task(id, principal));
    }
    throw new ProviderError('Connector cannot confirm this task’s state. Check the provider before starting it again.', 409);
  }
  async close() {
    this.closing = true;
    for (const running of this.running.values()) running.controller.abort();
    await Promise.allSettled([...this.running.values()].map(item => item.done));
    await Promise.allSettled([...this.polling.values(), ...this.cancelling.values()]);
  }
}
