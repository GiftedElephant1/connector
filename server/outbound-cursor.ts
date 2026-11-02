import { randomUUID } from 'node:crypto';
import { ProviderError } from './provider-types';

/** Cursor's user API key is stored by the caller; it is never returned by this adapter. */
export interface CursorConfig { apiKey: string; model: string }
export interface CursorModel { id: string; name: string; subscriptionEligible: boolean }
export type CursorStatus = 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
export interface CursorResult {
  /** Opaque agent ID, or agent ID + ':' + run ID once the initial run is known. */
  remoteId?: string;
  status: CursorStatus;
  result?: string;
  link?: string;
  error?: string;
}
export interface CursorAdapterOptions { fetch?: typeof fetch; timeoutMs?: number }

const ORIGIN = 'https://api.cursor.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 32 * 1024;
const MAX_RESULT_CHARACTERS = 200_000;
const AGENT_ID = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
// The current published subscription pool covers these model versions. This is
// deliberately not a prefix match, an alias, or an inference from displayName.
// Discovery must ALSO return the selected ID. Future versions require review.
const SUBSCRIPTION_MODELS = new Set([
  'composer-2.5', 'composer-2-5',
  'grok-4.5', 'grok-4-5', 'grok-4.6', 'grok-4-6', 'grok-4.7', 'grok-4-7',
]);

type JsonObject = Record<string, unknown>;
type Reply = { kind: 'ok'; body: JsonObject } | { kind: 'http'; status: number; code?: string } | { kind: 'unavailable' };
interface Reference { agentId: string; runId?: string }
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const referenceText = ({ agentId, runId }: Reference) => runId ? `${agentId}:${runId}` : agentId;
const link = ({ agentId }: Reference) => `https://cursor.com/agents/${agentId}`;

function configKey(config: CursorConfig): string {
  if (!config || typeof config.apiKey !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(config.apiKey)) {
    throw new ProviderError('Save a valid Cursor user API key before delegating a task.');
  }
  return config.apiKey;
}

function parseReference(value: string): Reference {
  if (typeof value !== 'string' || value.length > 100) throw new ProviderError('This Cursor task reference is invalid.');
  const parts = value.split(':');
  if (parts.length > 2 || !AGENT_ID.test(parts[0]) || (parts.length === 2 && !RUN_ID.test(parts[1]))) {
    throw new ProviderError('This Cursor task reference is invalid.');
  }
  return { agentId: parts[0], ...(parts[1] ? { runId: parts[1] } : {}) };
}

function clean(value: string, key: string, limit: number): string {
  return value.replaceAll(key, '[redacted]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit);
}

// Only documented codes select our own text. Upstream messages, links, and
// identifiers can contain private details and must never reach task/UI output.
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  plan_required: 'Cursor reports that this account needs a plan with Cloud Agents. Check that the key belongs to your subscribed account.',
  role_forbidden: 'Cursor reports that this account is not permitted to use this operation. Review its account or team permissions.',
  feature_unavailable: 'Cursor reports that this API feature is not enabled for this account.',
  key_not_supported: 'Cursor reports that this API key type is not supported for this operation. Review the key’s Cloud Agents access in your dashboard.',
  integration_not_connected: 'Cursor reports that a required account integration is not connected. Review Cloud Agents setup in your dashboard.',
  usage_limit_exceeded: 'Cursor reports that the account’s usage limit has been reached. Check its remaining subscription usage and limits.',
  rate_limit_exceeded: 'Cursor rate-limited the request. Wait before trying again.',
  unauthorized: 'Cursor rejected this API key. Save a valid Cursor user API key.',
  api_key_not_found: 'Cursor rejected this API key. Save a valid Cursor user API key.',
};

function errorCode(body: JsonObject): string | undefined {
  const code = object(body.error) ? body.error.code : undefined;
  return typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code) ? code : undefined;
}

function httpMessage(status: number, code?: string): string {
  if (code && Object.hasOwn(ERROR_MESSAGES, code)) return ERROR_MESSAGES[code];
  if (status === 401) return 'Cursor rejected this API key. Save a valid Cursor user API key.';
  if (status === 403) return 'Cursor denied access. Check the API key permissions and the account’s Cloud Agents eligibility.';
  if (status === 402) return 'Cursor requires available usage or billing authorization. Check your subscription limits before retrying.';
  if (status === 429) return 'Cursor rate-limited the request. Wait before trying again.';
  if (status >= 300 && status < 400) return 'Cursor returned an unexpected redirect; Connector did not follow it.';
  return `Cursor rejected the request (HTTP ${status}).`;
}

function uncertain(ref: Reference, message: string): CursorResult {
  return { remoteId: referenceText(ref), status: 'uncertain', link: link(ref), error: message };
}

function runResult(body: JsonObject, ref: Reference, key: string): CursorResult {
  if (body.id !== ref.runId || body.agentId !== ref.agentId) return uncertain(ref, 'Cursor returned a different run. Check this task in Cursor before retrying.');
  const base = { remoteId: referenceText(ref), link: link(ref) };
  switch (body.status) {
    case 'CREATING': case 'RUNNING': case 'WAITING_FOR_BACKGROUND_WORK':
      return { ...base, status: 'running' };
    case 'FINISHED': {
      if (body.result !== undefined && typeof body.result !== 'string') return uncertain(ref, 'Cursor finished the run but returned an unreadable result. Check it in Cursor.');
      const source = typeof body.result === 'string' ? body.result : '';
      const result = clean(source, key, MAX_RESULT_CHARACTERS);
      return { ...base, status: 'succeeded', result: result + (source.length > MAX_RESULT_CHARACTERS ? '\n\n[Connector truncated this response. Open the task in Cursor for the full result.]' : '') };
    }
    case 'CANCELLED': return { ...base, status: 'cancelled' };
    case 'ERROR': return { ...base, status: 'failed', error: 'The Cursor run failed. Open the task in Cursor for its diagnostic details.' };
    case 'EXPIRED': return { ...base, status: 'failed', error: 'The Cursor run expired. Review it in Cursor before starting another task.' };
    default: return uncertain(ref, 'Cursor returned an unfamiliar run status. Check this task in Cursor before retrying.');
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The transport may have observed cancellation while constructing promise.
    // Consume its eventual rejection even when we can stop waiting immediately.
    void promise.catch(() => {});
    throw new Error('Request interrupted');
  }
  let stop: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error('Request interrupted'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { if (stop) signal.removeEventListener('abort', stop); }
}

/** Official Cursor Cloud Agents v1 API. No implicit model defaults or POST retries. */
export class CursorOutboundAdapter {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: CursorAdapterOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 20_000, 120_000));
  }

  private async request(config: CursorConfig, path: string, method: 'GET' | 'POST', payload?: JsonObject, external?: AbortSignal): Promise<Reply> {
    const key = configKey(config);
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (external?.aborted) return { kind: 'unavailable' };
    external?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, this.timeoutMs);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const pending = this.fetcher(`${ORIGIN}${path}`, {
        method, redirect: 'manual', signal: controller.signal,
        headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      }).then(value => {
        if (controller.signal.aborted) void value.body?.cancel().catch(() => {});
        return value;
      });
      response = await abortable(pending, controller.signal);
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        return { kind: 'http', status: response.status };
      }
      const byteLimit = response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BYTES;
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && Number(length) > byteLimit) throw new Error('Response too large');
      if (!response.body) throw new Error('Empty response');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await abortable(reader.read(), controller.signal);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > byteLimit) throw new Error('Response too large');
        chunks.push(part.value);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(body)) throw new Error('Invalid response');
      if (!response.ok) return { kind: 'http', status: response.status, code: errorCode(body) };
      return { kind: 'ok', body };
    } catch {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      else void response?.body?.cancel().catch(() => {});
      // A malformed, oversized, or stalled error body must not hide an HTTP
      // refusal we already received, or turn a definite refusal into a retry.
      if (response && !response.ok) return { kind: 'http', status: response.status };
      return { kind: 'unavailable' };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', stop);
      if (reader) { try { reader.releaseLock(); } catch { /* A cancelled read can still be settling. */ } }
    }
  }

  async models(config: CursorConfig, signal?: AbortSignal): Promise<CursorModel[]> {
    const key = configKey(config);
    const response = await this.request(config, '/v1/models', 'GET', undefined, signal);
    if (response.kind === 'http') {
      const message = response.status === 403
        ? `Cursor denied access to its model list (HTTP 403). No task was sent. ${response.code ? httpMessage(response.status, response.code) + ' ' : ''}Open Cloud Agents in the same dashboard account and resolve any setup or access requirement, then reload subscription models.`
        : httpMessage(response.status, response.code);
      throw new ProviderError(message, response.status === 401 || response.status === 403 ? 400 : 502);
    }
    if (response.kind !== 'ok' || !Array.isArray(response.body.items) || response.body.items.length > 500) {
      throw new ProviderError('Cursor’s available models could not be verified. Try refreshing the model list.', 502);
    }
    const result: CursorModel[] = [];
    const seen = new Set<string>();
    for (const item of response.body.items) {
      if (!object(item) || !text(item.id) || !MODEL_ID.test(item.id) || item.id.includes(key) || seen.has(item.id)) continue;
      seen.add(item.id);
      result.push({ id: item.id, name: clean(text(item.displayName) ? item.displayName : item.id, key, 160), subscriptionEligible: SUBSCRIPTION_MODELS.has(item.id) });
    }
    return result;
  }

  async start(config: CursorConfig, prompt: string, signal?: AbortSignal): Promise<CursorResult> {
    configKey(config);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 50_000 || prompt.includes('\0')) throw new ProviderError('Provide a Cursor task between 1 and 50,000 characters.');
    if (typeof config.model !== 'string' || !SUBSCRIPTION_MODELS.has(config.model)) throw new ProviderError('Select an explicitly supported Cursor subscription model. Automatic and third-party model selection are not enabled.');
    if (signal?.aborted) return { status: 'cancelled', error: 'The task was cancelled before it was sent to Cursor.' };
    const available = await this.models(config, signal);
    if (!available.some(model => model.id === config.model && model.subscriptionEligible)) throw new ProviderError('The selected subscription model is not currently available to this Cursor account. Refresh the model list.');
    if (signal?.aborted) return { status: 'cancelled', error: 'The task was cancelled before it was sent to Cursor.' };
    const ref: Reference = { agentId: `bc-${randomUUID()}` };
    const response = await this.request(config, '/v1/agents', 'POST', {
      agentId: ref.agentId, prompt: { text: prompt }, model: { id: config.model },
    }, signal);
    if (response.kind === 'http' && response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status)) {
      return { status: 'failed', error: httpMessage(response.status, response.code) };
    }
    if (response.kind !== 'ok') return uncertain(ref, 'Cursor may have accepted this task, but its response was not confirmed. Check its status before starting another task.');
    const { agent, run } = response.body;
    if (!object(agent) || agent.id !== ref.agentId || !object(run) || !text(run.id) || !RUN_ID.test(run.id) || run.agentId !== ref.agentId || (agent.latestRunId !== undefined && agent.latestRunId !== run.id)) {
      return uncertain(ref, 'Cursor’s task response was incomplete. Check its status before starting another task.');
    }
    ref.runId = run.id;
    return runResult(run, ref, config.apiKey);
  }

  private async resolve(config: CursorConfig, ref: Reference, signal?: AbortSignal): Promise<Reference | CursorResult> {
    if (ref.runId) return ref;
    // A newly created agent has exactly one initial run. Do not mistake a later
    // follow-up started in Cursor for the task whose create response was lost.
    const response = await this.request(config, `/v1/agents/${ref.agentId}/runs?limit=2`, 'GET', undefined, signal);
    if (response.kind !== 'ok' || !Array.isArray(response.body.items) || response.body.items.length !== 1 || response.body.nextCursor !== undefined) {
      return uncertain(ref, 'Cursor’s initial run has not been located. Check the task in Cursor; do not automatically submit it again.');
    }
    const run = response.body.items[0];
    if (!object(run) || run.agentId !== ref.agentId || !text(run.id) || !RUN_ID.test(run.id)) return uncertain(ref, 'Cursor’s initial run could not be identified. Check the task in Cursor.');
    return { agentId: ref.agentId, runId: run.id };
  }

  async poll(config: CursorConfig, remoteId: string, signal?: AbortSignal): Promise<CursorResult> {
    configKey(config);
    const resolved = await this.resolve(config, parseReference(remoteId), signal);
    if ('status' in resolved) return resolved;
    const response = await this.request(config, `/v1/agents/${resolved.agentId}/runs/${resolved.runId}`, 'GET', undefined, signal);
    if (response.kind !== 'ok') return uncertain(resolved, 'Cursor’s run status could not be verified. The task may still be running; check it in Cursor.');
    return runResult(response.body, resolved, config.apiKey);
  }

  async cancel(config: CursorConfig, remoteId: string, signal?: AbortSignal): Promise<CursorResult> {
    configKey(config);
    const resolved = await this.resolve(config, parseReference(remoteId), signal);
    if ('status' in resolved) return resolved;
    const response = await this.request(config, `/v1/agents/${resolved.agentId}/runs/${resolved.runId}/cancel`, 'POST', undefined, signal);
    if (response.kind === 'http' && response.status === 409) return this.poll(config, referenceText(resolved), signal);
    if (response.kind === 'ok' && response.body.id === resolved.runId) return { remoteId: referenceText(resolved), status: 'cancelled', link: link(resolved) };
    return uncertain(resolved, 'Cursor cancellation was not confirmed. Check the run before assuming that it stopped.');
  }
}
