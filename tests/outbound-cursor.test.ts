import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CursorOutboundAdapter, type CursorConfig } from '../server/outbound-cursor.ts';

const config: CursorConfig = { apiKey: 'cursor-private-test-user-key-do-not-display', model: 'grok-4.7' };
const agentId = 'bc-11111111-1111-4111-8111-111111111111';
const runId = 'run-22222222-2222-4222-8222-222222222222';
const remoteId = `${agentId}:${runId}`;
const modelsBody = { items: [{ id: 'grok-4.7', displayName: 'Grok 4.7' }, { id: 'composer-2.5', displayName: 'Composer 2.5' }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: URL; method: string; headers: Headers; body?: Record<string, unknown>; signal?: AbortSignal | null; redirect?: RequestRedirect };
function fixture(handler: (call: Call) => Response | Promise<Response>, timeoutMs?: number) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const call: Call = { url: new URL(String(input)), method: init?.method || 'GET', headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal, redirect: init?.redirect };
    calls.push(call);
    assert.equal(call.url.origin, 'https://api.cursor.com', 'credentials must only go to the fixed official origin');
    assert.equal(call.redirect, 'manual');
    assert.equal(call.headers.get('authorization'), `Bearer ${config.apiKey}`);
    return handler(call);
  };
  return { adapter: new CursorOutboundAdapter({ fetch: fetcher, timeoutMs }), calls };
}
const run = (status: string, extra: Record<string, unknown> = {}) => ({ id: runId, agentId, status, ...extra });

test('Cursor discovers model IDs and never treats names, aliases, prefixes, or automatic defaults as subscription eligibility', async () => {
  const f = fixture(() => json({ items: [...modelsBody.items,
    { id: 'claude-opus', displayName: 'Composer 2.5', aliases: ['grok-4.7'] },
    { id: 'grok-4.7-paid-thirdparty', displayName: 'Grok 4.7' },
    { id: 'composer-latest', displayName: 'Composer 2.5' },
    { id: 'auto', displayName: 'Auto' },
    { id: 'grok-4.7', displayName: 'duplicate' },
    { id: config.apiKey, displayName: 'Reflected credential' },
    { id: '../malformed' },
  ] }));
  const models = await f.adapter.models(config);
  assert.deepEqual(models.filter(model => model.subscriptionEligible).map(model => model.id), ['grok-4.7', 'composer-2.5']);
  assert.equal(models.length, 6);
  assert.ok(!JSON.stringify(models).includes(config.apiKey));
  assert.equal(f.calls[0].url.pathname, '/v1/models');
  assert.equal(f.calls[0].method, 'GET');
});

test('Cursor creates a no-repository task with an explicit discovered model and an idempotency identifier', async () => {
  let createdId = '';
  const f = fixture(call => {
    if (call.url.pathname === '/v1/models') return json(modelsBody);
    assert.equal(call.method, 'POST');
    assert.equal(call.url.pathname, '/v1/agents');
    assert.match(String(call.body?.agentId), /^bc-[0-9a-f-]{36}$/);
    createdId = String(call.body?.agentId);
    assert.deepEqual(call.body, { agentId: createdId, prompt: { text: 'Draft a launch checklist.' }, model: { id: 'grok-4.7' } });
    return json({ agent: { id: createdId, latestRunId: runId, url: 'https://untrusted.example/steal' }, run: { id: runId, agentId: createdId, status: 'CREATING' } }, 201);
  });
  const result = await f.adapter.start(config, 'Draft a launch checklist.');
  assert.deepEqual(result, { remoteId: `${createdId}:${runId}`, status: 'running', link: `https://cursor.com/agents/${createdId}` });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('Cursor refuses unapproved/default models before POST and verifies account availability', async () => {
  const f = fixture(() => json({ items: [{ id: 'claude-opus', displayName: 'Claude' }] }));
  for (const model of ['claude-opus', 'auto', 'composer-latest', '', 'grok-4.7-fast-unknown']) {
    await assert.rejects(f.adapter.start({ ...config, model }, 'Task'), /subscription model/);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.adapter.start(config, 'Task'), /not currently available/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'GET');
});

test('Cursor does not forward raw provider error bodies or credentials', async () => {
  const f = fixture(() => json({ error: `${config.apiKey}: PRIVATE_UPSTREAM_DIAGNOSTIC` }, 401));
  await assert.rejects(f.adapter.models(config), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Cursor rejected this API key/);
    assert.doesNotMatch(error.message, /PRIVATE_UPSTREAM_DIAGNOSTIC|cursor-private-test/);
    return true;
  });
  const g = fixture(call => call.url.pathname === '/v1/models' ? json(modelsBody) : json({ error: 'PRIVATE_UPSTREAM_DIAGNOSTIC' }, 403));
  assert.deepEqual(await g.adapter.start(config, 'Task'), { status: 'failed', error: 'Cursor denied access. Check the API key permissions and the account’s Cloud Agents eligibility.' });
});

test('Cursor explains documented model-list denials without forwarding private provider details or sending a task', async () => {
  for (const [code, explanation] of [
    ['plan_required', /key belongs to your subscribed account/],
    ['role_forbidden', /account or team permissions/],
    ['feature_unavailable', /feature is not enabled/],
    ['key_not_supported', /API key type is not supported/],
    ['integration_not_connected', /required account integration is not connected/],
    ['usage_limit_exceeded', /usage limit has been reached/],
  ] as const) {
    const f = fixture(() => json({ error: { code, message: `${config.apiKey}: PRIVATE_UPSTREAM_DIAGNOSTIC`,
      helpUrl: `https://private.example/${config.apiKey}`, provider: 'PRIVATE_PROVIDER' } }, 403));
    await assert.rejects(f.adapter.start(config, 'Task'), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /model list \(HTTP 403\)\. No task was sent/);
      assert.match(error.message, explanation);
      assert.match(error.message, /Cloud Agents in the same dashboard account/);
      assert.doesNotMatch(error.message, /PRIVATE_|private\.example|cursor-private-test/);
      return true;
    });
    assert.deepEqual(f.calls.map(call => [call.method, call.url.pathname]), [['GET', '/v1/models']]);
  }
});

test('Cursor retains an actionable HTTP denial for unknown or malformed error bodies', async () => {
  for (const body of [
    JSON.stringify({ error: { code: config.apiKey, message: 'PRIVATE_UPSTREAM_DIAGNOSTIC' } }),
    JSON.stringify({ error: { code: 'toString' } }),
    JSON.stringify({ code: 'plan_required', message: 'PRIVATE_UPSTREAM_DIAGNOSTIC' }),
    JSON.stringify({ error: { code: ['plan_required'] } }),
    '<html>PRIVATE_UPSTREAM_DIAGNOSTIC</html>',
    '',
  ]) {
    const f = fixture(() => new Response(body, { status: 403 }));
    await assert.rejects(f.adapter.models(config), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Cursor denied access to its model list (HTTP 403). No task was sent. Open Cloud Agents in the same dashboard account and resolve any setup or access requirement, then reload subscription models.');
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('Cursor bounds and cancels oversized or stalled error bodies while preserving the HTTP refusal', async () => {
  for (const mode of ['declared-size', 'stream-size', 'stalled'] as const) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === 'stream-size') controller.enqueue(new Uint8Array(32 * 1024 + 1));
      },
      cancel() { cancelled = true; },
    });
    const f = fixture(() => new Response(body, { status: 403,
      ...(mode === 'declared-size' ? { headers: { 'content-length': String(32 * 1024 + 1) } } : {}),
    }), 15);
    const before = Date.now();
    await assert.rejects(f.adapter.start(config, 'Task'), /model list \(HTTP 403\)\. No task was sent/);
    assert.ok(Date.now() - before < 2_000);
    assert.equal(cancelled, true);
    assert.equal(f.calls[0].signal?.aborted, true);
    assert.deepEqual(f.calls.map(call => [call.method, call.url.pathname]), [['GET', '/v1/models']]);
  }
});

test('ambiguous Cursor creation keeps a recoverable agent reference and never retries the POST', async () => {
  let createdId = '';
  const f = fixture(call => {
    if (call.url.pathname === '/v1/models') return json(modelsBody);
    if (call.method === 'POST') { createdId = String(call.body?.agentId); return json({ error: 'upstream-failure' }, 503); }
    if (call.url.searchParams.get('limit') === '2') return json({ items: [{ id: runId, agentId: createdId, status: 'FINISHED' }] });
    return json({ id: runId, agentId: createdId, status: 'FINISHED', result: 'The launch checklist is ready.' });
  });
  const uncertain = await f.adapter.start(config, 'Task');
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.remoteId, createdId);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  const complete = await f.adapter.poll(config, uncertain.remoteId!);
  assert.equal(complete.status, 'succeeded');
  assert.equal(complete.remoteId, `${createdId}:${runId}`);
  assert.equal(complete.result, 'The launch checklist is ready.');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('ambiguous creation does not attribute a later follow-up run to the initial task', async () => {
  const f = fixture(() => json({ items: [run('FINISHED'), run('RUNNING', { id: 'run-33333333-3333-4333-8333-333333333333' })] }));
  const result = await f.adapter.poll(config, agentId);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.remoteId, agentId);
  assert.equal(f.calls.length, 1);
});

test('Cursor timeout is bounded and uncertain after transmission; pre-cancelled tasks never reach Cursor', async () => {
  const f = fixture(call => call.url.pathname === '/v1/models' ? json(modelsBody) : new Promise<Response>(() => {}), 15);
  const before = Date.now();
  const result = await f.adapter.start(config, 'Task');
  assert.equal(result.status, 'uncertain');
  assert.ok(Date.now() - before < 2_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].signal?.aborted, true);
  const stopped = new AbortController(); stopped.abort();
  assert.equal((await f.adapter.start(config, 'Task', stopped.signal)).status, 'cancelled');
  assert.equal(f.calls.length, 2);
});

test('Cursor rejects redirects without forwarding keys and treats malformed successful creation as uncertain', async () => {
  const f = fixture(() => new Response(null, { status: 302, headers: { location: 'https://untrusted.example/' } }));
  await assert.rejects(f.adapter.models(config), /unexpected redirect/);
  assert.equal(f.calls.length, 1);
  const g = fixture(call => call.url.pathname === '/v1/models' ? json(modelsBody) : new Response('<html>not an API result</html>'));
  assert.equal((await g.adapter.start(config, 'Task')).status, 'uncertain');
  assert.equal(g.calls.length, 2);
});

test('Cursor maps documented run statuses and protects result/error output', async () => {
  for (const [status, normalized] of [
    ['CREATING', 'running'], ['RUNNING', 'running'], ['WAITING_FOR_BACKGROUND_WORK', 'running'],
    ['FINISHED', 'succeeded'], ['ERROR', 'failed'], ['EXPIRED', 'failed'], ['CANCELLED', 'cancelled'], ['NEW_UNKNOWN', 'uncertain'],
  ]) {
    const f = fixture(() => json(run(status, { result: `Answer ${config.apiKey}`, error: 'PRIVATE_UPSTREAM_DIAGNOSTIC' })));
    const result = await f.adapter.poll(config, remoteId);
    assert.equal(result.status, normalized);
    assert.doesNotMatch(JSON.stringify(result), /cursor-private-test|PRIVATE_UPSTREAM_DIAGNOSTIC/);
    if (status === 'FINISHED') assert.equal(result.result, 'Answer [redacted]');
    else assert.equal(result.result, undefined);
    assert.equal(f.calls[0].url.pathname, `/v1/agents/${agentId}/runs/${runId}`);
  }
});

test('Cursor never treats a mismatched or malformed run as success and never accepts injected paths', async () => {
  for (const extra of [{ id: 'run-33333333-3333-4333-8333-333333333333' }, { agentId: 'bc-44444444-4444-4444-8444-444444444444' }, { result: { private: 'data' } }]) {
    const f = fixture(() => json(run('FINISHED', extra)));
    assert.equal((await f.adapter.poll(config, remoteId)).status, 'uncertain');
  }
  const f = fixture(() => { throw new Error('Must not fetch'); });
  for (const value of ['https://untrusted.example/', `${agentId}/../secrets`, `${agentId}:../../secret`, `${remoteId}:extra`]) {
    await assert.rejects(f.adapter.poll(config, value), /reference is invalid/);
  }
  assert.equal(f.calls.length, 0);
});

test('Cursor bounds response bytes and final result length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const f = fixture(() => new Response(stream));
  await assert.rejects(f.adapter.models(config), /could not be verified/);
  assert.equal(cancelled, true);
  const g = fixture(() => json(run('FINISHED', { result: 'A'.repeat(200_001) })));
  const result = await g.adapter.poll(config, remoteId);
  assert.equal(result.status, 'succeeded');
  assert.match(result.result!, /Connector truncated this response/);
  assert.ok(result.result!.length < 201_000);
});

test('Cursor acknowledges cancellation and resolves a completion race without falsely claiming cancellation', async () => {
  const f = fixture(call => {
    assert.equal(call.url.pathname, `/v1/agents/${agentId}/runs/${runId}/cancel`);
    assert.equal(call.method, 'POST');
    assert.equal(call.body, undefined);
    return json({ id: runId });
  });
  assert.equal((await f.adapter.cancel(config, remoteId)).status, 'cancelled');
  const g = fixture(call => call.method === 'POST' ? json({ error: 'run_not_cancellable' }, 409) : json(run('FINISHED', { result: 'Done before cancellation.' })));
  const result = await g.adapter.cancel(config, remoteId);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result, 'Done before cancellation.');
  assert.equal(g.calls.length, 2);
  const h = fixture(() => json({ error: 'PRIVATE_UPSTREAM_DIAGNOSTIC' }, 500));
  assert.equal((await h.adapter.cancel(config, remoteId)).status, 'uncertain');
});
