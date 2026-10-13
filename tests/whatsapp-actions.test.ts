import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { whatsappActions } from '../server/actions-whatsapp.ts';
import { ProviderError } from '../server/provider-types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'private-meta-token', fields: { phoneNumberId: '1234567890' } };
const action = (id: string) => whatsappActions.find((item) => item.definition.id === id)!;
const textValues = { recipient: '+886912345678', content: 'Hello', serviceWindow: 'open' };

test('WhatsApp sends text using a validated recipient, fixed phone path, and bearer token', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://graph.facebook.com/v26.0/1234567890/messages');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-meta-token');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '886912345678',
      type: 'text', text: { body: 'Hello', preview_url: false },
    });
    return Response.json({ messaging_product: 'whatsapp', contacts: [{ wa_id: '886912345678' }], messages: [{ id: 'wamid.example' }], access_token: 'upstream-secret' });
  };
  const result = await action('send-message').execute(credential, textValues, {});
  assert.deepEqual(result.items, [{ messageId: 'wamid.example', phoneNumberId: '1234567890' }]);
  assert.match(result.summary, /Delivery is not confirmed/);
  assert.equal(JSON.stringify(result).includes('upstream-secret'), false);
  assert.equal(action('send-message').definition.kind, 'write');
  assert.equal(action('send-message').definition.schedulable, undefined);
});

test('WhatsApp replies use the official context message ID and cannot be scheduled', async () => {
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).context, { message_id: 'wamid.HBgLMTIzNDU2Nzg5MA==' });
    return Response.json({ messages: [{ id: 'wamid.reply' }] });
  };
  await action('reply-message').execute(credential, { ...textValues, replyTo: 'wamid.HBgLMTIzNDU2Nzg5MA==' }, {});
  assert.equal(action('reply-message').definition.kind, 'write');
  assert.equal(action('reply-message').definition.schedulable, undefined);
});

test('WhatsApp refuses free text without an explicit open-window assertion and validates before sending', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({}); };
  await assert.rejects(action('send-message').execute(credential, { ...textValues, serviceWindow: '' }, {}), /last 24 hours/);
  await assert.rejects(action('send-message').execute(credential, { ...textValues, recipient: '+886 912 345 678' }, {}), /7–15 digits/);
  await assert.rejects(action('send-message').execute(credential, { ...textValues, recipient: '0123456789' }, {}), /7–15 digits/);
  await assert.rejects(action('send-message').execute(credential, { ...textValues, content: 'x'.repeat(4097) }, {}), /4,096/);
  await assert.rejects(action('reply-message').execute(credential, { ...textValues, replyTo: '123\nInjected' }, {}), /wamid/);
  await assert.rejects(action('send-message').execute({ ...credential, fields: { phoneNumberId: '../me' } }, textValues, {}), /numeric ID/);
  assert.equal(requests, 0);
});

test('WhatsApp approved templates support bounded positional text components and scheduling', async () => {
  const components = [{ type: 'header', parameters: [{ type: 'text', text: 'Order update' }] }, { type: 'body', parameters: [{ type: 'text', text: 'Alex' }] }];
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '886912345678', type: 'template',
      template: { name: 'order_update', language: { code: 'en_US' }, components },
    });
    return Response.json({ messages: [{ id: 'wamid.template' }] });
  };
  await action('send-template').execute(credential, { recipient: textValues.recipient, templateName: 'order_update', language: 'en_US', components: JSON.stringify(components) }, {});
  assert.equal(action('send-template').definition.kind, 'write');
  assert.equal(action('send-template').definition.schedulable, true);
});

test('WhatsApp plain templates omit optional components', async () => {
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).template, { name: 'hello_world', language: { code: 'en_US' } });
    return Response.json({ messages: [{ id: 'wamid.template' }] });
  };
  await action('send-template').execute(credential, { recipient: textValues.recipient, templateName: 'hello_world', language: 'en_US' }, {});
});

test('WhatsApp rejects unsupported or malformed template payloads without issuing writes', async () => {
  const values = { recipient: textValues.recipient, templateName: 'order_update', language: 'en_US' };
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({}); };
  await assert.rejects(action('send-template').execute(credential, { ...values, templateName: '../messages' }, {}), /Template name/);
  await assert.rejects(action('send-template').execute(credential, { ...values, language: 'en_US&bad' }, {}), /language code/);
  for (const components of [
    '{broken-json', '{}',
    JSON.stringify([{ type: 'body', parameters: [{ type: 'image', image: { link: 'https://example.com/image.png' } }] }]),
    JSON.stringify([{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'part' }] }]),
    JSON.stringify([{ type: 'body', parameters: [{ type: 'text', text: 'Alex', parameter_name: 'name' }] }]),
    JSON.stringify([{ type: 'body', parameters: [{ type: 'text', text: 'Alex' }], injected: 'field' }]),
    JSON.stringify([{ type: 'body', parameters: [{ type: 'text', text: 'x'.repeat(1025) }] }]),
    JSON.stringify([{ type: 'header', parameters: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }]),
    JSON.stringify([{ type: 'body', parameters: [] }]),
    JSON.stringify([{ type: 'body', parameters: [{ type: 'text', text: 'A' }] }, { type: 'body', parameters: [{ type: 'text', text: 'B' }] }]),
  ]) await assert.rejects(action('send-template').execute(credential, { ...values, components }, {}), ProviderError);
  assert.equal(requests, 0);
});

test('WhatsApp business profile and templates use fixed read endpoints and bounded useful fields', async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(init?.method, undefined);
    if (url.pathname.endsWith('/whatsapp_business_profile')) {
      assert.equal(url.pathname, '/v26.0/1234567890/whatsapp_business_profile');
      return Response.json({ data: [{ about: 'Shop', email: 'contact@example.com', websites: ['https://example.com'], access_token: 'not-returned' }] });
    }
    if (url.pathname.endsWith('/message_templates')) {
      assert.equal(url.pathname, '/v26.0/998877/message_templates');
      assert.equal(url.searchParams.get('limit'), '100');
      return Response.json({ data: Array.from({ length: 105 }, (_, index) => ({ id: String(index), name: 'order_update', status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hi {{1}}' }], access_token: 'not-returned' })) });
    }
    assert.equal(url.pathname, '/v26.0/1234567890');
    return Response.json({ id: '1234567890', display_phone_number: '+886912345678', verified_name: 'Shop' });
  };
  const profile = await action('get-business-profile').execute(credential, {}, {});
  assert.equal(profile.items?.[0].about, 'Shop');
  assert.equal(JSON.stringify(profile).includes('not-returned'), false);
  const templates = await action('list-templates').execute(credential, { businessAccountId: '998877' }, {});
  assert.equal(templates.items?.length, 100);
  assert.equal(templates.items?.[0].status, 'APPROVED');
  assert.equal(JSON.stringify(templates).includes('not-returned'), false);
  const phone = await action('get-phone').execute(credential, {}, {});
  assert.equal(phone.items?.[0].phoneNumberId, '1234567890');
});

test('WhatsApp upstream failures and missing message IDs remain private and warn about retry ambiguity', async () => {
  globalThis.fetch = async () => Response.json({ error: { message: 'private-meta-token upstream-secret' } }, { status: 400 });
  await assert.rejects(action('send-message').execute(credential, textValues, {}), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(/private-meta-token|upstream-secret/.test(error.message), false);
    assert.match(error.message, /before retrying/);
    return true;
  });
  globalThis.fetch = async () => Response.json({ success: true });
  await assert.rejects(action('send-message').execute(credential, textValues, {}), /Check the recipient conversation before retrying/);
  globalThis.fetch = async () => { throw new Error('network-failure private-meta-token'); };
  await assert.rejects(action('send-message').execute(credential, textValues, {}), /may have accepted/);
});
