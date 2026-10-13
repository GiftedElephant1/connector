import { apiJson, apiRequest, required, records, string } from './action-http';
import { ProviderError } from './provider-types';
import type { ActionAdapter, ActionValues } from './action-types';

function botHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.DISCORD_BOT_TOKEN?.trim();
  if (!token || /[\r\n]/.test(token)) throw new ProviderError('Set DISCORD_BOT_TOKEN on the server and add that bot to the target server before using Discord messages.');
  return { authorization: `Bot ${token}` };
}
function snowflake(values: ActionValues, key: string): string {
  const value = required(values, key);
  if (!/^\d{1,30}$/.test(value)) throw new ProviderError(`${key} must be a Discord numeric ID.`);
  return value;
}
const channelField = { name: 'channelId', label: 'Channel ID', type: 'text' as const, required: true, help: 'The bot must be a member with access to this channel. Enable Developer Mode in Discord to copy IDs.' };
const contentField = { name: 'content', label: 'Message', type: 'textarea' as const, required: true, help: 'Up to 2,000 characters. Mentions will not notify users.' };

async function send(values: ActionValues, env: NodeJS.ProcessEnv, reply: boolean) {
  const channelId = snowflake(values, 'channelId');
  const content = required(values, 'content');
  if (content.length > 2000) throw new ProviderError('Discord messages can contain at most 2,000 characters.');
  const payload: Record<string, unknown> = { content, allowed_mentions: { parse: [], replied_user: false } };
  if (reply) payload.message_reference = { message_id: snowflake(values, 'replyTo'), fail_if_not_exists: true };
  const result = await apiJson('Discord', `https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST', headers: { ...botHeaders(env), 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (typeof result.id !== 'string') throw new ProviderError('Discord did not return a message ID. Check the channel before retrying.', 502);
  return { summary: reply ? 'Discord reply sent as your bot.' : 'Discord message published as your bot.', items: [{ messageId: result.id, channelId }] };
}

export const discordActions: ActionAdapter[] = [
  {
    provider: 'discord',
    definition: { id: 'publish-message', label: 'Publish bot message', group: 'publishing', kind: 'write', schedulable: true, description: 'Send a channel message as your configured Discord bot. Requires DISCORD_BOT_TOKEN and channel permissions.', fields: [channelField, contentField] },
    execute: async (_credential, values, env) => send(values, env, false),
  },
  {
    provider: 'discord',
    definition: { id: 'list-messages', label: 'Read channel messages', group: 'inbox', kind: 'read', description: 'Read up to 50 recent messages available to your bot. Message Content intent may be required to see message text.', fields: [channelField] },
    execute: async (_credential, values, env) => {
      const channelId = snowflake(values, 'channelId');
      const { body } = await apiRequest('Discord', `https://discord.com/api/v10/channels/${channelId}/messages?limit=50`, { headers: botHeaders(env) });
      if (!Array.isArray(body)) throw new ProviderError('Discord returned an invalid message list.', 502);
      return { summary: 'Recent messages visible to your Discord bot.', items: records(body).slice(0, 50).map((message) => ({ messageId: string(message.id), content: string(message.content), timestamp: string(message.timestamp), authorId: typeof message.author === 'object' && message.author !== null ? string((message.author as Record<string, unknown>).id) : '' })) };
    },
  },
  {
    provider: 'discord',
    definition: { id: 'reply-message', label: 'Reply as bot', group: 'inbox', kind: 'write', description: 'Reply to an existing message in a channel your bot can access. No user-account automation is used.', fields: [channelField, { name: 'replyTo', label: 'Message ID to reply to', type: 'text', required: true }, contentField] },
    execute: async (_credential, values, env) => send(values, env, true),
  },
];
