import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { discordActions } from '../server/actions-discord';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'user-oauth-token-must-not-send' };
const env = { DISCORD_BOT_TOKEN: 'bot-secret' };
const action = (id: string) => discordActions.find((item) => item.definition.id === id)!;

test('Discord publication uses the bot identity, suppresses mentions, and is schedulable', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://discord.com/api/v10/channels/123/messages');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bot bot-secret');
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { content: 'Hello @everyone', allowed_mentions: { parse: [], replied_user: false } });
    assert.equal(JSON.stringify(init).includes(credential.accessToken), false);
    return Response.json({ id: '456', channel_id: '123' });
  };
  assert.equal(action('publish-message').definition.schedulable, true);
  const result = await action('publish-message').execute(credential, { channelId: '123', content: 'Hello @everyone' }, env);
  assert.equal(result.items?.[0].messageId, '456');
});

test('Discord replies use message_reference and are never scheduled', async () => {
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.message_reference, { message_id: '999', fail_if_not_exists: true });
    assert.equal(body.allowed_mentions.replied_user, false);
    return Response.json({ id: '456' });
  };
  assert.equal(action('reply-message').definition.schedulable, undefined);
  await action('reply-message').execute(credential, { channelId: '123', replyTo: '999', content: 'Reply' }, env);
});

test('Discord reads messages with bot permissions and maps only useful fields', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://discord.com/api/v10/channels/123/messages?limit=50');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bot bot-secret');
    return Response.json([{ id: '456', content: 'Text', timestamp: '2026-01-01', author: { id: '789', email: 'omit@example.com' }, attachments: [{ secret: 'omit' }] }]);
  };
  const result = await action('list-messages').execute(credential, { channelId: '123' }, env);
  assert.deepEqual(result.items, [{ messageId: '456', content: 'Text', timestamp: '2026-01-01', authorId: '789' }]);
});

test('Discord rejects missing bot credentials, invalid IDs, and overlong messages before writing', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return Response.json({}); };
  await assert.rejects(action('publish-message').execute(credential, { channelId: '123', content: 'Text' }, {}), /DISCORD_BOT_TOKEN/);
  await assert.rejects(action('publish-message').execute(credential, { channelId: '../users', content: 'Text' }, env), /numeric ID/);
  await assert.rejects(action('publish-message').execute(credential, { channelId: '123', content: 'x'.repeat(2001) }, env), /2,000/);
  assert.equal(requests, 0);
});
