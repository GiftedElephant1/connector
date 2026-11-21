import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserActions, type BrowserMachineService } from '../server/browser-tools';
import { ProviderError } from '../server/provider-types';

const secret = 'private-runtime-value-not-for-tools';
const page = { sessionId: 'session-1', origin: 'https://example.com', title: 'Example', text: 'Public page', elements: [{ ref: 'e1', role: 'button', name: 'Continue', secret }], secret };
function fixture() {
  let enabled = true, authenticated = true, executions = 0;
  let before: (() => Promise<void>) | undefined;
  const service: BrowserMachineService = {
    hasAccess: principal => enabled && principal === 'key:allowed',
    open: async (_input, _principal, guard) => { guard?.(); await before?.(); guard?.(); executions++; return page; },
    snapshotPage: async (_input, _principal, guard) => { guard?.(); return page; },
    navigate: async (_input, _principal, guard) => { guard?.(); return page; },
    click: async (_input, _principal, guard) => { guard?.(); return page; },
    type: async (_input, _principal, guard) => { guard?.(); return page; },
    signIn: async (_input, _principal, guard) => { guard?.(); return { sessionId: 'session-1', origin: 'https://example.com', status: 'filled', filled: 'username_and_password', message: 'Filled.', secret }; },
    closeSession: async (_input, _principal, guard) => { guard?.(); return { sessionId: 'session-1', status: 'closed', secret }; },
  };
  const actions = new BrowserActions(service, 'key:allowed', () => { if (!authenticated) throw new ProviderError('Authentication revoked.', 401); });
  return { actions, service, enable(value: boolean) { enabled = value; }, authenticate(value: boolean) { authenticated = value; }, before(fn: () => Promise<void>) { before = fn; }, executions: () => executions };
}
test('browser tools and classic actions project only documented public results', async () => {
  const f = fixture(), tools = f.actions.tools();
  assert.deepEqual(Object.keys(tools).sort(), ['browser_click', 'browser_close', 'browser_navigate', 'browser_open', 'browser_sign_in', 'browser_snapshot', 'browser_type']);
  assert.equal(f.actions.connections()[0].provider, 'browser');
  const opened = await tools.browser_open!.run({ url: 'https://example.com', confirmed: true });
  assert.equal(JSON.stringify(opened).includes(secret), false);
  assert.equal(JSON.stringify(await tools.browser_sign_in!.run({ sessionId: 'session-1', confirmed: true })).includes(secret), false);
  assert.equal(JSON.stringify(await tools.browser_close!.run({ sessionId: 'session-1' })).includes(secret), false);
  const classic = await f.actions.run('open', { url: 'https://example.com' }, true);
  assert.equal(classic.browser.sessionId, 'session-1');
  assert.equal(JSON.stringify(classic).includes(secret), false);
  assert.equal(classic.result.items?.[1].ref, 'e1');
  await f.actions.run('snapshot', { sessionId: 'session-1' }, undefined);
});
test('browser tools reject missing confirmation, arbitrary code and credential read selectors', async () => {
  const f = fixture(), tools = f.actions.tools();
  for (const input of [{ url: 'https://example.com' }, { url: 'https://example.com', confirmed: false }, { url: 'https://example.com', confirmed: true, script: 'document.cookie' }]) await assert.rejects(tools.browser_open!.run(input));
  await assert.rejects(tools.browser_sign_in!.run({ sessionId: 'session-1', confirmed: true, itemId: 'arbitrary' }));
  await assert.rejects(tools.browser_type!.run({ sessionId: 'session-1', ref: 'e1', confirmed: true, text: 'hello', selector: 'input' }));
  await assert.rejects(f.actions.run('close', { sessionId: 'session-1' }, undefined), /Confirm/);
  await assert.rejects(f.actions.run('open', { url: 'https://example.com', confirmed: true }, true));
  await assert.rejects(f.actions.run('read-secret', {}, true), /not supported/);
  assert.equal(f.executions(), 0);
});
test('previously discovered browser tools recheck access during awaited operations', async () => {
  const f = fixture(), tools = f.actions.tools();
  f.enable(false);
  assert.deepEqual(f.actions.tools(), {});
  assert.deepEqual(f.actions.connections(), []);
  await assert.rejects(tools.browser_open!.run({ url: 'https://example.com', confirmed: true }), /not enabled/);
  f.enable(true); f.before(async () => { f.enable(false); });
  await assert.rejects(tools.browser_open!.run({ url: 'https://example.com', confirmed: true }), /not enabled/);
  assert.equal(f.executions(), 0);
  f.enable(true); f.before(async () => { f.authenticate(false); });
  await assert.rejects(tools.browser_open!.run({ url: 'https://example.com', confirmed: true }), /Authentication revoked/);
  assert.equal(f.executions(), 0);
});
