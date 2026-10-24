import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTunnelDriver, type ForwardOptions, type NativeTunnelListener, type TunnelSession, type TunnelSessionBuilder } from '../server/tunnel-driver';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const statuses: string[] = [];
  const calls: { token?: string; scheme?: string; domain?: string; addr?: string; builders: number; connects: number; sessionCloses: number; listenerCloses: number; joins: number; endpoints: number } = { builders: 0, connects: 0, sessionCloses: 0, listenerCloses: 0, joins: 0, endpoints: 0 };
  let disconnect!: (addr: string, error: string) => boolean;
  let heartbeat!: (latency: number) => void;
  let onConnect: (() => Promise<TunnelSession>) | undefined;
  let onListen: (() => Promise<NativeTunnelListener>) | undefined;
  let onClose: (() => Promise<void>) | undefined;
  let onJoin: (() => Promise<void>) | undefined;
  const rawListener = {
    url: () => 'https://assigned.ngrok-free.dev',
    join: async () => { calls.joins++; if (onJoin) await onJoin(); },
    close: async () => { calls.listenerCloses++; throw new Error('Offline listener RPC cannot close'); },
  };
  const endpoint = {
    scheme(value: string) { calls.scheme = value; return this; },
    domain(value: string) { calls.domain = value; return this; },
    async listenAndForward(addr: string) { calls.addr = addr; return onListen ? onListen() : rawListener; },
  };
  const session: TunnelSession = {
    httpEndpoint() { calls.endpoints++; return endpoint; },
    async close() { calls.sessionCloses++; if (onClose) await onClose(); },
  };
  const builder: TunnelSessionBuilder = {
    authtoken(value) { calls.token = value; return this; },
    handleDisconnection(handler) { disconnect = handler; return this; },
    handleHeartbeat(handler) { heartbeat = handler; return this; },
    async connect() { calls.connects++; return onConnect ? onConnect() : session; },
  };
  const driver = createTunnelDriver(() => { calls.builders++; return builder; });
  const options: ForwardOptions = { addr: 'http://127.0.0.1:3000', authtoken: 'private-authtoken', domain: 'assigned.ngrok-free.dev', force_new_session: true, onStatusChange: value => statuses.push(value) };
  return {
    driver, options, calls, statuses, session, rawListener,
    disconnect: () => disconnect('native-private-address', 'private-auth-token-error'),
    heartbeat: (latency = 5) => heartbeat(latency),
    setConnect: (value: typeof onConnect) => { onConnect = value; },
    setListen: (value: typeof onListen) => { onListen = value; },
    setClose: (value: typeof onClose) => { onClose = value; },
    setJoin: (value: typeof onJoin) => { onJoin = value; },
  };
}

test('tunnel driver uses an explicit HTTPS session and closes its transport while listener RPC would reject', async () => {
  const f = fixture();
  const listener = await f.driver.forward(f.options);
  assert.equal(listener.url(), 'https://assigned.ngrok-free.dev');
  assert.equal(f.calls.token, 'private-authtoken');
  assert.equal(f.calls.scheme, 'HTTPS');
  assert.equal(f.calls.domain, 'assigned.ngrok-free.dev');
  assert.equal(f.calls.addr, 'http://127.0.0.1:3000');
  assert.equal(f.calls.builders, 1);
  assert.equal(f.calls.connects, 1);
  assert.equal(f.disconnect(), true);
  await listener.close();
  assert.equal(f.calls.sessionCloses, 1);
  assert.equal(f.calls.listenerCloses, 1, 'the listener reference is released only after its transport and task stop');
  assert.equal(listener.url(), null);
  await listener.close();
  await f.driver.close!();
  assert.equal(f.calls.sessionCloses, 1);
});

test('each tunnel driver owns a new session and never closes another connection', async () => {
  const a = fixture(), b = fixture();
  const first = await a.driver.forward({ ...a.options, domain: undefined, force_new_session: false });
  const second = await b.driver.forward(b.options);
  assert.equal(a.calls.domain, undefined);
  assert.equal(a.calls.builders, 1);
  assert.equal(b.calls.builders, 1);
  await first.close();
  assert.equal(a.calls.sessionCloses, 1);
  assert.equal(b.calls.sessionCloses, 0);
  assert.equal(second.url(), 'https://assigned.ngrok-free.dev');
  await assert.rejects(a.driver.forward(a.options), /already been used/);
  assert.equal(a.calls.builders, 1);
  await second.close();
});

test('heartbeat only reports reconnection after an interruption and closed sessions ignore callbacks', async () => {
  const f = fixture();
  const listener = await f.driver.forward(f.options);
  f.heartbeat();
  assert.deepEqual(f.statuses, []);
  assert.equal(f.disconnect(), true);
  f.heartbeat();
  f.heartbeat();
  assert.deepEqual(f.statuses, ['closed', 'connected']);
  assert.equal(f.disconnect(), true);
  await listener.close();
  f.heartbeat();
  assert.equal(f.disconnect(), false);
  assert.deepEqual(f.statuses, ['closed', 'connected', 'closed']);
  assert.equal(f.statuses.join(',').includes('private'), false);
});

test('missing or invalid native heartbeat latency never claims a restored connection', async () => {
  const f = fixture();
  const listener = await f.driver.forward(f.options);
  f.disconnect();
  f.heartbeat(Number.NaN);
  f.heartbeat(-1);
  f.heartbeat(Number.POSITIVE_INFINITY);
  // The native SDK can pass null despite declaring a numeric callback.
  f.heartbeat(null as unknown as number);
  assert.deepEqual(f.statuses, ['closed']);
  f.heartbeat(0);
  assert.deepEqual(f.statuses, ['closed', 'connected']);
  await listener.close();
});

test('concurrent closes share one pending native close and a rejected close can be retried', async () => {
  const f = fixture(), firstClose = deferred<void>();
  f.setClose(() => firstClose.promise);
  const listener = await f.driver.forward(f.options);
  const a = listener.close(), b = f.driver.close!();
  assert.equal(a, b);
  while (!f.calls.sessionCloses) await Promise.resolve();
  assert.equal(f.calls.sessionCloses, 1);
  firstClose.reject(new Error('Transport close failed'));
  await assert.rejects(a, /Transport close failed/);
  assert.equal(listener.url(), 'https://assigned.ngrok-free.dev', 'failed cleanup must not pretend the listener is gone');
  f.setClose(undefined);
  await listener.close();
  assert.equal(f.calls.sessionCloses, 2);
  assert.equal(listener.url(), null);
});

test('failed endpoint setup closes the owned session and preserves the original failure', async () => {
  const f = fixture(), cause = new Error('Endpoint setup failed ERR_NGROK_123');
  f.setListen(async () => { throw cause; });
  await assert.rejects(f.driver.forward(f.options), error => error === cause);
  assert.equal(f.calls.sessionCloses, 1);
  assert.equal(f.calls.listenerCloses, 0);
  f.heartbeat();
  f.disconnect();
  assert.deepEqual(f.statuses, []);
  await f.driver.close!();
  assert.equal(f.calls.sessionCloses, 1);
});

test('failed endpoint cleanup retains its session for an explicit retry', async () => {
  const f = fixture(), cause = new Error('Endpoint setup failed');
  f.setListen(async () => { throw cause; });
  f.setClose(async () => { throw new Error('Close failed'); });
  await assert.rejects(f.driver.forward(f.options), error => error === cause);
  assert.equal(f.calls.sessionCloses, 1);
  f.setClose(undefined);
  await f.driver.close!();
  assert.equal(f.calls.sessionCloses, 2);
});

test('closing a pending connection waits for and closes its eventual owned session before any endpoint opens', async () => {
  const f = fixture(), connected = deferred<TunnelSession>();
  f.setConnect(() => connected.promise);
  const opening = f.driver.forward(f.options);
  const rejected = assert.rejects(opening, /cancelled/);
  await Promise.resolve();
  const closing = f.driver.close!();
  assert.equal(f.calls.sessionCloses, 0);
  connected.resolve(f.session);
  await closing;
  await rejected;
  assert.equal(f.calls.endpoints, 0);
  assert.equal(f.calls.sessionCloses, 1);
});

test('closing while endpoint creation is pending waits and never exposes the late listener', async () => {
  const f = fixture(), listening = deferred<NativeTunnelListener>();
  f.setListen(() => listening.promise);
  const opening = f.driver.forward(f.options);
  const rejected = assert.rejects(opening, /cancelled/);
  while (!f.calls.endpoints) await Promise.resolve();
  const closing = f.driver.close!();
  while (!f.calls.sessionCloses) await Promise.resolve();
  assert.equal(f.calls.sessionCloses, 1);
  listening.resolve(f.rawListener);
  await closing;
  await rejected;
  assert.equal(f.calls.sessionCloses, 1);
  assert.equal(f.calls.listenerCloses, 1);
});

test('stop waits for forwarding exit and a late reconnect heartbeat closes the current transport again', async () => {
  const f = fixture(), joined = deferred<void>();
  f.setJoin(() => joined.promise);
  const listener = await f.driver.forward(f.options);
  const closing = listener.close();
  let finished = false;
  void closing.then(() => { finished = true; });
  while (!f.calls.sessionCloses) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(f.disconnect(), false);
  f.heartbeat();
  while (f.calls.sessionCloses < 2) await Promise.resolve();
  assert.equal(f.calls.listenerCloses, 0, 'no offline unlisten RPC can obstruct transport shutdown');
  joined.resolve();
  await closing;
  assert.equal(f.calls.joins, 1);
  assert.equal(listener.url(), null);
  assert.equal(f.calls.listenerCloses, 1);
});

test('known native offline close errors require confirmed task exit; native task errors also confirm exit', async () => {
  const f = fixture(), joined = deferred<void>();
  f.setJoin(() => joined.promise);
  f.setClose(async () => { throw new Error('failed to close session: transport error'); });
  const listener = await f.driver.forward(f.options);
  const closing = listener.close();
  let finished = false;
  void closing.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  joined.reject(new Error('error on join: native task canceled'));
  await closing;
  assert.equal(listener.url(), null);
  assert.equal(f.calls.joins, 1);
});

test('a late reconnect close failure stays retryable even if the forwarding task subsequently exits', async () => {
  const f = fixture(), joined = deferred<void>();
  f.setJoin(() => joined.promise);
  const listener = await f.driver.forward(f.options);
  const closing = listener.close();
  const rejected = assert.rejects(closing, /Late transport close failed/);
  await new Promise(resolve => setImmediate(resolve));
  f.setClose(async () => { throw new Error('Late transport close failed'); });
  f.heartbeat();
  await new Promise(resolve => setImmediate(resolve));
  joined.resolve();
  await rejected;
  assert.notEqual(listener.url(), null);
  assert.equal(f.calls.listenerCloses, 0);
  f.setClose(undefined);
  await listener.close();
  assert.equal(f.calls.joins, 1);
  assert.equal(listener.url(), null);
});

test('unexpected join errors never prove shutdown and the native join handle is not awaited twice', async () => {
  const f = fixture();
  f.setJoin(async () => { throw new Error('Listener is no longer running'); });
  const listener = await f.driver.forward(f.options);
  await assert.rejects(listener.close(), /no longer running/);
  await assert.rejects(listener.close(), /no longer running/);
  assert.equal(f.calls.joins, 1);
  assert.equal(f.calls.listenerCloses, 0);
  assert.notEqual(listener.url(), null);
});

test('failed native connection and preclosed driver do not leave a session or allow a new attempt', async () => {
  const f = fixture();
  f.setConnect(async () => { throw new Error('Connect failed'); });
  await assert.rejects(f.driver.forward(f.options), /Connect failed/);
  await f.driver.close!();
  assert.equal(f.calls.sessionCloses, 0);
  const unused = fixture();
  await unused.driver.close!();
  await assert.rejects(unused.driver.forward(unused.options), /already been used/);
  assert.equal(unused.calls.builders, 0);
});

test('observer exceptions cannot escape into the native disconnection or heartbeat handlers', async () => {
  const f = fixture();
  const listener = await f.driver.forward({ ...f.options, onStatusChange: () => { throw new Error('Observer failed'); } });
  assert.equal(f.disconnect(), true);
  assert.doesNotThrow(f.heartbeat);
  await listener.close();
});
