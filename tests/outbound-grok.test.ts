import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createGrokStarter, validateGrokConfig } from '../server/outbound-grok.ts';
import { ProviderError } from '../server/provider-types.ts';

const config = { webhookUrl: 'https://hooks.example.com/routines/routine-123', webhookKey: 'routine-secret-do-not-return' };
const publicAnswer = { address: '93.184.216.34', family: 4 };
type ResponseStream = PassThrough & { statusCode: number };
type Outgoing = EventEmitter & { destroyed: boolean; destroy: () => void; end: (body?: string) => void };

function fixture(options: {
  addresses?: LookupAddress[];
  lookup?: (host: string) => Promise<LookupAddress[]>;
  status?: number;
  holdResponse?: boolean;
  requestFailure?: boolean;
  response?: (incoming: ResponseStream, outgoing: Outgoing) => void;
  requestTimeoutMs?: number;
  lookupTimeoutMs?: number;
} = {}) {
  const resolutions: string[] = [];
  const calls: { url: URL; options: RequestOptions; body?: string; incoming: ResponseStream; outgoing: Outgoing }[] = [];
  const lookup = async (hostname: string) => {
    resolutions.push(hostname);
    return options.lookup ? options.lookup(hostname) : options.addresses ?? [publicAnswer];
  };
  const request = ((url: URL, requestOptions: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const incoming = Object.assign(new PassThrough(), { statusCode: options.status ?? 200 });
    const outgoing = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() { this.destroyed = true; incoming.destroy(); },
      end(body?: string) {
        call.body = body;
        queueMicrotask(() => {
          if (options.requestFailure) { outgoing.emit('error', new Error(`${config.webhookKey} upstream request failure`)); return; }
          if (options.holdResponse) return;
          callback(incoming as unknown as IncomingMessage);
          options.response?.(incoming, outgoing);
        });
      },
    });
    const call = { url, options: requestOptions, body: undefined as string | undefined, incoming, outgoing };
    calls.push(call);
    return outgoing;
  }) as unknown as typeof https.request;
  return { start: createGrokStarter({ lookup, request, requestTimeoutMs: options.requestTimeoutMs ?? 1000, lookupTimeoutMs: options.lookupTimeoutMs ?? 1000 }), calls, resolutions };
}

function publicError(error: unknown) {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.message.includes(config.webhookKey), false);
  assert.equal(error.message.includes(config.webhookUrl), false);
  assert.equal(error.message.includes('upstream request failure'), false);
  return true;
}

test('Grok config validates only the routine URL/key and preserves valid URL path/query', () => {
  assert.deepEqual(validateGrokConfig({
    webhookUrl: ' https://Hooks.Example.com:443/routines/abc?version=1 ',
    webhookKey: ` ${config.webhookKey} `, headers: { authorization: 'override' },
  }), { webhookUrl: 'https://hooks.example.com/routines/abc?version=1', webhookKey: config.webhookKey });
  for (const input of [null, [], {}, { webhookUrl: config.webhookUrl }, { ...config, webhookKey: '' },
    { ...config, webhookKey: `Bearer ${config.webhookKey}` }, { ...config, webhookKey: 'value\r\nInjected: yes' },
    { ...config, webhookKey: 'x'.repeat(4097) }]) {
    assert.throws(() => validateGrokConfig(input), ProviderError);
  }
});

test('Grok config rejects non-HTTPS, ambiguous, and private destinations before sending secrets', () => {
  for (const webhookUrl of [
    'http://hooks.example.com/task', 'file:///tmp/secret', 'https://user:password@hooks.example.com',
    'https://hooks.example.com:8443/task', 'https://hooks.example.com/#fragment', 'https://hooks.example.com/#',
    'https://hooks.example.com/path with space', 'https://hooks.example.com/\\private',
    'https://hooks.example.com/path%0aheader', 'https://hooks.example.com/%00',
    'https://localhost/task', 'https://localhost./task', 'https://printer/task',
    'https://device.local/task', 'https://service.internal./task', 'https://service.lan/task',
    'https://127.0.0.1/task', 'https://2130706433/task', 'https://0x7f000001/task',
    'https://10.0.0.1/task', 'https://169.254.169.254/task', 'https://192.0.2.1/task',
    'https://[::1]/task', 'https://[::ffff:127.0.0.1]/task', 'https://[2001:db8::1]/task',
  ]) assert.throws(() => validateGrokConfig({ ...config, webhookUrl }), ProviderError, webhookUrl);
});

test('Grok accepts only wholly public DNS answers, including rejecting mixed and mismatched records', async () => {
  for (const addresses of [
    [], [{ address: '10.0.0.1', family: 4 }],
    [publicAnswer, { address: '169.254.169.254', family: 4 }],
    [{ address: '2606:4700:4700::1111', family: 6 }, { address: 'fd00::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: publicAnswer.address, family: 6 }],
  ]) {
    const f = fixture({ addresses });
    await assert.rejects(f.start(config, 'List my accounts', 'task-1'), /public internet addresses/);
    assert.equal(f.calls.length, 0);
  }
});

test('Grok pins one DNS answer for the TLS request without proxy or pooled socket bypass', async () => {
  for (const address of [publicAnswer, { address: '2606:4700:4700::1111', family: 6 }]) {
    const f = fixture({ addresses: [address] });
    await f.start(config, 'List my accounts', 'task-1');
    assert.deepEqual(f.resolutions, ['hooks.example.com']);
    const call = f.calls[0];
    assert.equal(call.url.hostname, 'hooks.example.com');
    assert.equal(call.options.agent, false);
    assert.notEqual(call.options.rejectUnauthorized, false);
    const pinned = call.options.lookup as unknown as (host: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void;
    let answer: unknown[] = [];
    pinned('hooks.example.com', { all: false }, (...args) => { answer = args; });
    assert.deepEqual(answer, [null, address.address, address.family]);
    pinned('hooks.example.com', { all: true }, (...args) => { answer = args; });
    assert.deepEqual(answer, [null, [address]]);
    assert.equal(f.resolutions.length, 1);
  }
});

test('Grok submits the owner prompt and task ID once, and reports accepted rather than completed', async () => {
  const f = fixture({ response: incoming => {
    assert.equal(incoming.destroyed, true);
    assert.equal(incoming.listenerCount('data'), 0, 'Do not parse or return an upstream body.');
    assert.doesNotThrow(() => incoming.emit('error', new Error(config.webhookKey)));
  } });
  const result = await f.start(config, '  Read the account list.\nDo not publish anything.  ', 'task-123');
  assert.equal(result.status, 'submitted');
  assert.match(result.result, /not a completed answer/);
  assert.equal(result.result.includes(config.webhookKey), false);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.options.method, 'POST');
  assert.deepEqual(JSON.parse(call.body!), { taskId: 'task-123', prompt: '  Read the account list.\nDo not publish anything.  ' });
  assert.deepEqual(call.options.headers, {
    accept: 'application/json', 'content-type': 'application/json',
    authorization: `Bearer ${config.webhookKey}`, 'content-length': Buffer.byteLength(call.body!),
  });
  assert.equal(call.outgoing.destroyed, true);
});

test('Grok rejects redirects and every non-200 status without retrying or exposing response details', async () => {
  for (const status of [201, 202, 204, 301, 302, 307, 308, 400, 401, 403, 404, 429, 500]) {
    const f = fixture({ status, response: incoming => {
      assert.equal(incoming.destroyed, true);
      incoming.emit('error', new Error(config.webhookKey));
      incoming.emit('aborted');
    } });
    await assert.rejects(f.start(config, 'List accounts', 'task-1'), publicError);
    assert.equal(f.calls.length, 1, `No retry or redirect for ${status}.`);
    assert.equal(f.calls[0].outgoing.destroyed, true);
  }
});

test('Grok bounds task inputs before DNS or network access', async () => {
  for (const [prompt, id] of [['', 'task-1'], ['  ', 'task-1'], ['x'.repeat(100_001), 'task-1'], ['List accounts', 'bad id'], ['List accounts', 'x'.repeat(129)]]) {
    const f = fixture();
    await assert.rejects(f.start(config, prompt, id), ProviderError);
    assert.equal(f.resolutions.length, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('Grok DNS failure and timeout are sanitized and do not submit a task', async () => {
  for (const lookup of [
    async () => { throw new Error(config.webhookKey); },
    () => new Promise<LookupAddress[]>(() => {}),
  ]) {
    const f = fixture({ lookup, lookupTimeoutMs: 5 });
    await assert.rejects(f.start(config, 'List accounts', 'task-1'), error => {
      publicError(error);
      assert.match((error as Error).message, /No task was sent/);
      return true;
    });
    assert.equal(f.calls.length, 0);
  }
});

test('Grok transport failure and timeout report uncertainty without an automatic retry', async () => {
  for (const f of [fixture({ requestFailure: true }), fixture({ holdResponse: true, requestTimeoutMs: 5 })]) {
    await assert.rejects(f.start(config, 'List accounts', 'task-1'), error => {
      publicError(error);
      assert.match((error as Error).message, /may have started/);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].outgoing.destroyed, true);
  }
});

test('Grok honors cancellation before submission and during DNS resolution', async () => {
  const already = new AbortController(); already.abort(new Error(config.webhookKey));
  const before = fixture();
  await assert.rejects(before.start(config, 'List accounts', 'task-1', already.signal), publicError);
  assert.equal(before.resolutions.length, 0);
  const pending = new AbortController();
  const during = fixture({ lookup: () => new Promise<LookupAddress[]>(() => {}) });
  const task = during.start(config, 'List accounts', 'task-1', pending.signal);
  pending.abort(new Error(config.webhookKey));
  await assert.rejects(task, publicError);
  assert.equal(during.calls.length, 0);
});

test('Grok cancellation closes an in-flight request but does not claim to stop a remote routine', async () => {
  const controller = new AbortController();
  const f = fixture({ holdResponse: true });
  const task = f.start(config, 'List accounts', 'task-1', controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  controller.abort(new Error(config.webhookKey));
  await assert.rejects(task, error => {
    publicError(error);
    assert.match((error as Error).message, /may still run/);
    return true;
  });
  assert.equal(f.calls[0].outgoing.destroyed, true);
});
