import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Pipeline } from '../server/pipeline.ts';
import { Store } from '../server/store.ts';
import { ProviderError, type Credential } from '../server/provider-types.ts';
import { validateValues } from '../server/actions.ts';
import type { ActionAdapter, ActionResult, ActionValues } from '../server/action-types.ts';

const key = Buffer.alloc(32, 47);
const account = { accountName: 'Test account', resources: [] };
const outcome: ActionResult = { summary: 'Submitted once.', items: [{ id: 'post-123' }] };

function fixture(t: TestContext, execute: ActionAdapter['execute'] = async () => outcome, path = ':memory:', refresh: (credential: Credential) => Promise<Credential> = async credential => credential) {
  const store = new Store(path, key);
  t.after(() => store.close());
  store.save('x', { accessToken: 'test-platform-private-token' }, account);
  const adapters: ActionAdapter[] = [
    { provider: 'x', definition: { id: 'read', label: 'Read', group: 'analytics', kind: 'read', description: 'Test read', fields: [] }, execute },
    { provider: 'x', definition: { id: 'publish', label: 'Publish', group: 'publishing', kind: 'write', schedulable: true, description: 'Test write', fields: [{ name: 'text', label: 'Text', type: 'textarea', required: true }] }, execute },
  ];
  const actionService = {
    getAction: (provider: string, id: string) => {
      const action = adapters.find(candidate => candidate.provider === provider && candidate.definition.id === id);
      if (!action) throw new ProviderError('Unsupported action.', 404);
      return action;
    },
    listActions: (provider: string) => adapters.filter(action => action.provider === provider).map(action => action.definition),
    validateValues,
  };
  const credentials = { refreshCredential: async (_provider: string, credential: Credential) => refresh(credential) };
  return { store, pipeline: new Pipeline(store, {}, actionService, credentials), actionService, credentials };
}

function status(code: number) { return (error: unknown) => error instanceof ProviderError && error.status === code; }

test('reads execute without confirmation or a receipt; writes require explicit confirmation and a request ID', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return outcome; });
  assert.deepEqual(await f.pipeline.run('x', 'read', {}, undefined), { result: outcome });
  assert.equal(f.pipeline.jobs().length, 0);
  for (const confirmed of [undefined, false, 'true', 1]) {
    await assert.rejects(f.pipeline.run('x', 'publish', { text: 'Hello' }, confirmed, 'request-123'), status(409));
  }
  for (const requestId of [undefined, '', 'short', 'invalid request ID', 'x'.repeat(129)]) {
    await assert.rejects(f.pipeline.run('x', 'publish', { text: 'Hello' }, true, requestId), status(400));
  }
  assert.equal(calls, 1);
  assert.equal(f.pipeline.jobs().length, 0);
});

test('write receipts make retries idempotent and reject reuse for changed content', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return outcome; });
  const first = await f.pipeline.run('x', 'publish', { text: 'Hello' }, true, 'request-123');
  const repeated = await f.pipeline.run('x', 'publish', { text: 'Hello' }, true, 'request-123');
  assert.deepEqual(repeated, first);
  assert.equal(first.job?.status, 'succeeded');
  assert.equal(calls, 1);
  await assert.rejects(f.pipeline.run('x', 'publish', { text: 'Changed' }, true, 'request-123'), status(409));
  assert.equal(calls, 1);
});

test('a concurrent duplicate cannot execute the same write twice', async (t) => {
  let calls = 0;
  let complete!: (result: ActionResult) => void;
  const f = fixture(t, async () => { calls++; return new Promise(resolve => { complete = resolve; }); });
  const original = f.pipeline.run('x', 'publish', { text: 'Hello' }, true, 'concurrent-123');
  assert.equal(f.store.job('concurrent-123')?.status, 'running');
  await assert.rejects(f.pipeline.run('x', 'publish', { text: 'Hello' }, true, 'concurrent-123'), status(409));
  assert.equal(calls, 1);
  complete(outcome);
  assert.equal((await original).job?.status, 'succeeded');
});

test('invalid input and disconnected accounts are rejected before creating jobs or calling providers', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return outcome; });
  for (const values of [{}, { text: 1 }, { text: 'Hello', unexpected: 'field' }, [], null]) {
    await assert.rejects(f.pipeline.run('x', 'publish', values, true, 'invalid-123'), status(400));
  }
  await assert.rejects(f.pipeline.run('x', 'unsupported', {}, true, 'invalid-123'), status(404));
  f.store.disconnect('x');
  await assert.rejects(f.pipeline.run('x', 'publish', { text: 'Hello' }, true, 'missing-123'), status(409));
  assert.equal(calls, 0);
  assert.equal(f.pipeline.jobs().length, 0);
});

test('schedule validates timezone, confirmation, eligible action, range and idempotency', (t) => {
  const f = fixture(t);
  const scheduledAt = new Date(Date.now() + 60_000).toISOString();
  assert.throws(() => f.pipeline.schedule('x', 'read', {}, scheduledAt, true, 'schedule-123'), status(400));
  assert.throws(() => f.pipeline.schedule('x', 'publish', { text: 'Hello' }, scheduledAt, false, 'schedule-123'), status(409));
  for (const time of ['2026-10-13T10:00:00', 'invalidZ', new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 367 * 86400_000).toISOString()]) {
    assert.throws(() => f.pipeline.schedule('x', 'publish', { text: 'Hello' }, time, true, 'schedule-123'), status(400));
  }
  const pending = f.pipeline.schedule('x', 'publish', { text: 'Hello' }, scheduledAt, true, 'schedule-123');
  assert.equal(pending.status, 'pending');
  assert.deepEqual(f.pipeline.schedule('x', 'publish', { text: 'Hello' }, scheduledAt, true, 'schedule-123'), pending);
  assert.throws(() => f.pipeline.schedule('x', 'publish', { text: 'Changed' }, scheduledAt, true, 'schedule-123'), status(409));
});

test('persisted due jobs are claimed once and future or cancelled jobs never execute', async (t) => {
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);
  const seen: ActionValues[] = [];
  const f = fixture(t, async (_credential, values) => { seen.push(values); return outcome; });
  f.pipeline.schedule('x', 'publish', { text: 'Due' }, new Date(now + 10_000).toISOString(), true, 'due-request');
  f.pipeline.schedule('x', 'publish', { text: 'Future' }, new Date(now + 120_000).toISOString(), true, 'future-request');
  f.pipeline.schedule('x', 'publish', { text: 'Cancelled' }, new Date(now + 10_000).toISOString(), true, 'cancel-request');
  assert.equal(f.pipeline.cancel('cancel-request').status, 'cancelled');
  clock.mock.mockImplementation(() => now + 20_000);
  await f.pipeline.startScheduler()();
  assert.deepEqual(seen, [{ text: 'Due' }]);
  assert.equal(f.store.job('due-request')?.status, 'succeeded');
  assert.equal(f.store.job('future-request')?.status, 'pending');
  assert.equal(f.store.job('cancel-request')?.status, 'cancelled');
  assert.equal(f.store.claimJob('due-request'), false);
  assert.throws(() => f.pipeline.cancel('due-request'), status(409));
  await f.pipeline.startScheduler()();
  assert.equal(seen.length, 1);
});

test('restart preserves pending jobs and marks interrupted running jobs uncertain without replay', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'connector-restart-'));
  const path = join(directory, 'connector.sqlite');
  const original = new Store(path, key);
  original.save('x', { accessToken: 'test-private-token' }, account);
  original.createJob('pending-job', 'pending-fingerprint', 'x', 'publish', { text: 'Pending' }, Date.now() - 1000);
  original.createJob('interrupted-job', 'interrupted-fingerprint', 'x', 'publish', { text: 'Already submitted' }, Date.now() - 1000);
  assert.equal(original.claimJob('interrupted-job'), true);
  assert.equal(original.claimJob('interrupted-job'), false);
  original.close();
  const seen: ActionValues[] = [];
  const f = fixture(t, async (_credential, values) => { seen.push(values); return outcome; }, path);
  // Hooks run in registration order; Windows requires closing SQLite before removal.
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(f.store.job('pending-job')?.status, 'pending');
  assert.equal(f.store.job('interrupted-job')?.status, 'running');
  await f.pipeline.startScheduler()();
  assert.deepEqual(seen, [{ text: 'Pending' }]);
  assert.equal(f.store.job('pending-job')?.status, 'succeeded');
  assert.equal(f.store.job('interrupted-job')?.status, 'uncertain');
  assert.match(f.store.job('interrupted-job')?.error || '', /restarted/);
});

test('queued content and completed results are encrypted in SQLite and journals', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'connector-jobs-'));
  const f = fixture(t, undefined, join(directory, 'connector.sqlite'));
  // Register removal after the fixture's database-close hook.
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const text = 'private-unpublished-post-content';
  const result = { summary: 'private-platform-response-text' };
  f.pipeline.schedule('x', 'publish', { text }, new Date(Date.now() + 60_000).toISOString(), true, 'encrypted-job');
  assert.deepEqual(f.store.jobValues('encrypted-job'), { text });
  assert.equal(JSON.stringify(f.pipeline.jobs()).includes(text), false);
  f.store.claimJob('encrypted-job');
  f.store.finishJob('encrypted-job', 'succeeded', result);
  assert.deepEqual(f.store.job('encrypted-job')?.result, result);
  for (const name of readdirSync(directory)) {
    const bytes = readFileSync(join(directory, name));
    for (const secret of [text, result.summary, 'test-platform-private-token']) assert.equal(bytes.includes(Buffer.from(secret)), false);
  }
});

test('explicit upstream rejection is failed, ambiguous or partial failures are uncertain, and none replay', async (t) => {
  const cases = [
    { error: new ProviderError('Permission denied.', 403), expected: 'failed' },
    { error: new ProviderError('Temporarily limited.', 429), expected: 'failed' },
    { error: new ProviderError('Response unavailable; the first stage may have completed.', 502), expected: 'uncertain' },
    { error: new Error('raw-private-credential-in-internal-error'), expected: 'uncertain' },
  ];
  for (const [index, item] of cases.entries()) {
    let calls = 0;
    const f = fixture(t, async () => { calls++; throw item.error; });
    const id = `failure-${index}`;
    await assert.rejects(f.pipeline.run('x', 'publish', { text: 'Hello' }, true, id));
    assert.equal(f.store.job(id)?.status, item.expected);
    assert.equal(f.store.job(id)?.error?.includes('raw-private-credential'), false);
    await assert.rejects(f.pipeline.run('x', 'publish', { text: 'Hello' }, true, id), status(409));
    await f.pipeline.startScheduler()();
    assert.equal(calls, 1);
  }
});

test('rotated refresh credentials are saved before an action can fail', async (t) => {
  const fresh = { accessToken: 'fresh-access-token', refreshToken: 'rotated-refresh-token', expiresAt: Date.now() + 3600_000 };
  let refreshes = 0;
  const f = fixture(t, async credential => {
    assert.deepEqual(credential, fresh);
    throw new ProviderError('Could not determine publication outcome.', 502);
  }, ':memory:', async () => { refreshes++; return fresh; });
  f.store.save('x', { accessToken: 'old-token', refreshToken: 'old-refresh', expiresAt: Date.now() - 1000 }, account);
  await assert.rejects(f.pipeline.run('x', 'publish', { text: 'Hello' }, true, 'refresh-request'), status(502));
  assert.equal(refreshes, 1);
  assert.deepEqual(f.store.credential('x'), fresh);
  assert.equal(f.store.job('refresh-request')?.status, 'uncertain');
});
