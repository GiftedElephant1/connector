import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { whatsappAdapters } from '../server/providers-whatsapp.ts';
import { ProviderError } from '../server/provider-types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const adapter = whatsappAdapters[0];
const credential = { accessToken: 'private-meta-token', fields: { phoneNumberId: '1234567890' } };

test('WhatsApp uses a dashboard credential connection with a required phone number ID', () => {
  assert.equal(adapter.definition.id, 'whatsapp');
  assert.equal(adapter.definition.category, 'communications');
  assert.equal(adapter.definition.authType, 'api_key');
  assert.deepEqual(adapter.requiredEnv, []);
  assert.deepEqual(adapter.definition.credentialFields, [{ name: 'phoneNumberId', label: 'Phone number ID' }]);
  assert.equal(adapter.authorize, undefined);
});

test('WhatsApp verifies the business phone over the official Graph API without exposing credentials', async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(url.pathname, '/v26.0/1234567890');
    assert.equal(url.searchParams.get('fields'), 'id,display_phone_number,verified_name');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-meta-token');
    assert.equal(init?.method, undefined);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return Response.json({ id: '1234567890', display_phone_number: '+886 912 345 678', verified_name: 'Example Shop', access_token: 'never-return-this' });
  };
  const result = await adapter.verify(credential, {});
  assert.deepEqual(result, {
    accountId: '1234567890', accountName: 'Example Shop (+886 912 345 678)',
    resources: [{ id: '1234567890', name: 'Example Shop (+886 912 345 678)', type: 'whatsapp-phone-number' }],
  });
  assert.equal(JSON.stringify(result).includes('never-return-this'), false);
});

test('WhatsApp rejects absent IDs, unsafe graph paths, and invalid tokens before network access', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({}); };
  for (const phoneNumberId of ['', '../me', '123?access_token=bad', 'https://other.example', '123/messages', '9'.repeat(41)]) {
    await assert.rejects(adapter.verify({ ...credential, fields: { phoneNumberId } }, {}), /numeric ID/);
  }
  await assert.rejects(adapter.verify({ accessToken: 'token' }, {}), /numeric ID/);
  await assert.rejects(adapter.verify({ ...credential, accessToken: 'token\nInjected: yes' }, {}), /valid API key/);
  assert.equal(requests, 0);
});

test('WhatsApp rejects wrong phone responses and redacts upstream errors', async () => {
  globalThis.fetch = async () => Response.json({ id: '999', display_phone_number: '+18885551234' });
  await assert.rejects(adapter.verify(credential, {}), /invalid phone number profile/);
  globalThis.fetch = async () => Response.json({ id: '1234567890' });
  await assert.rejects(adapter.verify(credential, {}), /invalid phone number profile/);
  globalThis.fetch = async () => Response.json({ error: { message: 'private-meta-token upstream-secret' } }, { status: 401 });
  await assert.rejects(adapter.verify(credential, {}), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 401);
    assert.equal(/private-meta-token|upstream-secret/.test(error.message), false);
    return true;
  });
  globalThis.fetch = async () => Response.json({ error: { message: 'upstream-secret' } });
  await assert.rejects(adapter.verify(credential, {}), /denied access/);
});
