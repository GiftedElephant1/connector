import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { OutboundAI, type OutboundDependencies } from '../server/outbound-ai';
import { Store } from '../server/store';
import { ProviderError } from '../server/provider-types';
import type { AiTask, StoredAiTask } from '../server/outbound-types';

const key = Buffer.alloc(32, 18);
const request = { provider: 'claude', prompt: 'Draft a short note.', confirmed: true, requestId: 'test-task-123' };
function fixture(t: TestContext, deps: OutboundDependencies = {}) {
  const store = new Store(':memory:', key);
  const ai = new OutboundAI(store, ':memory:', { localRun: async () => ({ result: 'A draft.' }), ...deps });
  t.after(async () => { await ai.close(); store.close(); });
  ai.configure('claude', { enabled: true });
  return { ai, store };
}
async function finished(ai: OutboundAI, id: string, principal = 'owner'): Promise<AiTask> {
  for (let tries = 0; tries < 200; tries++) {
    const task = await ai.get(id, principal);
    if (task.status !== 'running') return task;
    await setImmediate();
  }
  throw new Error('Fixture did not finish');
}
const status = (code: number) => (error: unknown) => error instanceof ProviderError && error.status === code;

test('readiness failures replace stale success and expose only safe diagnostics to the delegating AI', async t => {
  let fail = false;
  const {ai} = fixture(t, {localCheck: async () => {
    if (fail) throw new ProviderError('Antigravity configuration (~/.gemini/config/config.json) contains malformed JSON.');
    return {available: true, authenticated: null, status: 'unverified', message: 'Installed; sign-in has not been checked.'};
  }});
  ai.configure('gemini', {enabled: true});
  assert.equal((await ai.check('gemini')).provider.check?.status, 'ready');
  fail = true;
  const checked = await ai.checkForAgent('gemini', 'oauth:approved-source');
  assert.equal(checked.check?.status, 'action_required');
  assert.match(checked.check?.message || '', /config\/config.json/);
  assert.equal(ai.agents('oauth:approved-source').agents.find(agent => agent.provider === 'gemini')?.check?.status, 'action_required');
  assert.equal('executable' in checked, false);
  assert.equal(ai.listTasks('owner').length, 0, 'checking readiness must not create a task');
});

test('unexpected readiness failures never expose provider output or private configuration text', async t => {
  const {ai} = fixture(t, {localCheck: async () => {throw new Error('private-settings-content');}});
  const result = await ai.check('claude');
  assert.equal(result.provider.check?.status, 'action_required');
  assert.ok(!JSON.stringify(result).includes('private-settings-content'));
});

test('outbound task retries are idempotent before and after completion, with strict confirmation and validation', async t => {
  let calls = 0;
  const {ai} = fixture(t, { localRun: async () => { calls++; return {result: 'Done'}; } });
  for (const input of [{...request, confirmed: false}, {...request, prompt: ' '}, {...request, requestId: 'bad id'}, {...request, prompt: 'x'.repeat(16001)}, {...request, shell: 'unexpected'}]) assert.throws(() => ai.start('owner', input));
  const first = ai.start('owner', request);
  assert.equal(ai.start('owner', request).id, first.id);
  assert.throws(() => ai.start('owner', {...request, prompt: 'Different'}), status(409));
  const done = await finished(ai, first.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result, 'Done');
  assert.equal(ai.start('owner', request).status, 'succeeded');
  assert.equal(calls, 1);
});

test('shared key requires owner opt-in; task results are isolated by caller and old connections stay intact', async t => {
  const { ai, store } = fixture(t);
  store.save('x', {accessToken: 'existing-private-platform-token'}, {accountName: 'Keep me', resources: []});
  assert.equal(ai.agents('key:original').delegationAllowed, false);
  assert.throws(() => ai.start('key:original', request), status(403));
  ai.access({allowSharedKey: true});
  const first = ai.start('key:original', request);
  await finished(ai, first.id, 'key:original');
  assert.equal(ai.listTasks('oauth:another').length, 0);
  await assert.rejects(ai.get(first.id, 'oauth:another'), status(404));
  await assert.rejects(ai.get(first.id, 'key:rotated'), status(404));
  assert.equal(ai.listTasks('owner').length, 1);
  assert.equal(store.credential('x')?.accessToken, 'existing-private-platform-token');
  ai.access({allowSharedKey: false});
  await assert.rejects(ai.get(first.id, 'key:original'), status(403));
});

test('configuration snapshots and task receipts never disclose credentials or remote references', async t => {
  const {ai} = fixture(t);
  ai.configure('cursor', {enabled: true, apiKey: 'private-cursor-api-key', model: 'grok-4.7'});
  ai.configure('grok', {enabled: true, webhookUrl: 'https://public.example.com/private-webhook-path', webhookKey: 'private-webhook-key'});
  ai.configure('cursor', {enabled: false, apiKey: '', model: 'grok-4.7'});
  ai.configure('grok', {enabled: false, webhookUrl: '', webhookKey: ''});
  const snapshot = JSON.stringify(ai.snapshot());
  for (const secret of ['private-cursor-api-key', 'private-webhook-path', 'private-webhook-key']) assert.ok(!snapshot.includes(secret));
  assert.equal(ai.snapshot().providers.find(item => item.id === 'cursor')?.hasApiKey, true);
  assert.equal(ai.snapshot().providers.find(item => item.id === 'grok')?.hasWebhookUrl, true);
  assert.throws(() => ai.configure('claude', {enabled: true, executable: 'bash -c echo'}));
  assert.throws(() => ai.configure('claude', {enabled: true, webhookKey: 'foreign-field'}));
  assert.throws(() => ai.configure('grok', {enabled: true, webhookUrl: 'http://127.0.0.1/secret', webhookKey: 'key'}));
});

test('only one local task per provider runs, cancellation stops it, and disabling prevents new starts', async t => {
  let aborts = 0;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const {ai} = fixture(t, {localRun: async (_provider, _config, _prompt, {signal}) => {
    started();
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => { aborts++; reject(new ProviderError('The AI task was cancelled.', 409)); }, {once: true}));
  }});
  const task = ai.start('owner', request);
  assert.throws(() => ai.start('owner', {...request, requestId: 'second-task'}), status(429));
  await began;
  await assert.rejects(ai.cancel(task.id, 'owner', false), status(409));
  assert.equal((await ai.cancel(task.id, 'owner', true)).status, 'cancelled');
  assert.equal(aborts, 1);
  ai.configure('claude', {enabled: false});
  assert.throws(() => ai.start('owner', {...request, requestId: 'third-task'}), status(409));
});

test('Grok acceptance is submitted, never completed; delivery errors do not replay', async t => {
  let calls = 0;
  const {ai} = fixture(t, {grokStart: async () => { calls++; return {status: 'submitted', result: 'Read the answer in Grok Bot.'}; }});
  ai.configure('grok', {enabled: true, webhookUrl: 'https://public.example.com/hook', webhookKey: 'fixture-key'});
  const input = {...request, provider: 'grok'};
  const task = ai.start('owner', input);
  const result = await finished(ai, task.id);
  assert.equal(result.status, 'submitted');
  await assert.rejects(ai.cancel(task.id, 'owner', true), status(409));
  assert.equal(ai.start('owner', input).status, 'submitted');
  assert.equal(calls, 1);
});

test('an unconfirmed local process stop remains uncertain rather than claiming cancellation', async t => {
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const {ai} = fixture(t, {localRun: async (_provider, _config, _prompt, {signal}) => {
    started();
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new ProviderError('Could not confirm the process stopped.', 502)), {once: true}));
  }});
  const task = ai.start('owner', request);
  await began;
  assert.equal((await ai.cancel(task.id, 'owner', true)).status, 'uncertain');
});

test('changing Cursor model preserves active run access and changing credentials leaves an explicit uncertain receipt', async t => {
  let polls = 0;
  const {ai} = fixture(t, {cursor: {
    models: async () => [], start: async () => ({status: 'running', remoteId: 'known-run'}),
    poll: async () => {polls++; return {status: 'running'};}, cancel: async () => ({status: 'cancelled'}),
  }});
  ai.configure('cursor', {enabled: true, apiKey: 'original-cursor-key', model: 'grok-4.7'});
  const task = ai.start('owner', {...request, provider: 'cursor'});
  await setImmediate();
  ai.configure('cursor', {enabled: true, model: 'composer-2.5'});
  assert.equal((await ai.get(task.id, 'owner')).status, 'running');
  assert.equal(polls, 1);
  assert.throws(() => ai.start('owner', {...request, provider: 'cursor', requestId: 'still-active'}), status(429));
  ai.configure('cursor', {enabled: true, apiKey: 'replacement-cursor-key'});
  const changed = await ai.get(task.id, 'owner');
  assert.equal(changed.status, 'uncertain');
  assert.match(changed.error!, /Cursor.*changed|original Cursor/);
  assert.equal(polls, 1, 'The old run is never polled with another account credential');
  assert.equal(ai.start('owner', {...request, provider: 'cursor', requestId: 'explicit-new-task'}).status, 'running');
});

test('known Cursor run is polled and cancelled without a second launch; credentials are not in receipts', async t => {
  let starts = 0; let polls = 0; let cancels = 0;
  const {ai} = fixture(t, {cursor: {
    models: async () => [{id: 'grok-4.7', name: 'Grok 4.7', subscriptionEligible: true}],
    start: async () => { starts++; return {status: 'running', remoteId: 'agent1:run1'}; },
    poll: async (_config, remoteId) => { polls++; assert.equal(remoteId, 'agent1:run1'); return {status: 'running'}; },
    cancel: async (_config, remoteId) => { cancels++; assert.equal(remoteId, 'agent1:run1'); return {status: 'cancelled'}; },
  }});
  ai.configure('cursor', {enabled: true, apiKey: 'cursor-private-key', model: 'grok-4.7'});
  assert.equal((await ai.check('cursor')).provider.check?.status, 'ready');
  const task = ai.start('owner', {...request, provider: 'cursor'});
  await setImmediate();
  const running = await ai.get(task.id, 'owner');
  assert.equal(running.status, 'running');
  assert.ok(!JSON.stringify(running).includes('agent1'));
  assert.equal((await ai.cancel(task.id, 'owner', true)).status, 'cancelled');
  assert.equal(starts, 1); assert.equal(polls, 1); assert.equal(cancels, 1);
});

test('unexpected provider failure is redacted and idempotency prevents an uncertain resubmission', async t => {
  let calls = 0;
  const {ai} = fixture(t, {grokStart: async () => { calls++; throw new Error('private-key-from-upstream'); }});
  ai.configure('grok', {enabled: true, webhookUrl: 'https://public.example.com/hook', webhookKey: 'private-key'});
  const input = {...request, provider: 'grok'};
  const task = ai.start('owner', input);
  assert.equal((await finished(ai, task.id)).status, 'uncertain');
  assert.ok(!JSON.stringify(await ai.get(task.id, 'owner')).includes('private-key'));
  ai.start('owner', input);
  assert.equal(calls, 1);
});

test('restart marks interrupted local tasks uncertain and preserves encrypted history without replay', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'connector-outbound-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, 'connector.sqlite');
  let store = new Store(path, key);
  const id = 'a'.repeat(64);
  const task: StoredAiTask = {id, provider: 'claude', principal: 'owner', fingerprint: 'fixture', configGeneration: 'fixture', prompt: 'Private task text not on disk.', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
  store.saveAiTask(id, task);
  store.close();
  assert.ok(!readFileSync(path).includes(Buffer.from(task.prompt)));
  store = new Store(path, key);
  let calls = 0;
  const ai = new OutboundAI(store, path, {localRun: async () => {calls++; return {result: 'not expected'}; }});
  assert.equal((await ai.get(id, 'owner')).status, 'uncertain');
  assert.equal((await ai.get(id, 'owner')).prompt, task.prompt);
  assert.equal(calls, 0);
  await ai.close(); store.close();
});
