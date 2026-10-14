import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';

const origin = process.env.CONNECTOR_URL || process.env.APP_ORIGIN || 'http://localhost:3000';
const key = process.env.PIPELINE_API_KEY;
if (!key) { console.error('Run npm run setup and configure PIPELINE_API_KEY first.'); process.exit(1); }
const url = new URL(origin);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
  console.error('Remote Connector URLs must use HTTPS.'); process.exit(1);
}
if (url.username || url.password) { console.error('CONNECTOR_URL must not contain credentials.'); process.exit(1); }
const approveWrites = process.argv.includes('--approve-writes');
const promptIndex = process.argv.indexOf('--message');
const oneMessage = promptIndex >= 0 ? process.argv[promptIndex + 1] : undefined;
const rl = createInterface({ input: stdin, output: stdout });
const messages = [];
const toolPaths = new Set(['list_connections', 'list_actions', 'run_action', 'schedule_post', 'list_jobs', 'cancel_job']);

async function request(path, body) {
  const response = await fetch(new URL(path, url), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Connector returned HTTP ${response.status}.`);
  return result;
}

async function turn(prompt) {
  messages.push({ role: 'user', content: prompt });
  for (let round = 0; round < 12; round++) {
    const { message } = await request('/api/v1/bot/turn', { messages, ...(process.env.XAI_MODEL ? { model: process.env.XAI_MODEL } : {}) });
    messages.push(message);
    if (message.content) console.log(`\nxAI: ${message.content}`);
    if (!message.tool_calls?.length) return;
    for (const call of message.tool_calls) {
      let result;
      let executedRequestId;
      try {
        const name = call.function?.name;
        if (!toolPaths.has(name)) throw new Error('The bot requested an unsupported tool.');
        const args = JSON.parse(call.function.arguments);
        const possibleWrite = name === 'schedule_post' || name === 'cancel_job' || (name === 'run_action' && args.confirmed === true);
        if (possibleWrite) {
          if (name !== 'cancel_job') args.requestId ||= randomUUID();
          executedRequestId = args.requestId;
          console.log(`\nRequested action: ${name}\n${JSON.stringify(args, null, 2)}`);
          const approved = approveWrites || (stdin.isTTY && (await rl.question('Execute this action? [y/N] ')).trim().toLowerCase() === 'y');
          if (!approved) throw new Error('The user did not approve this write. Do not retry it.');
          args.confirmed = true;
        }
        result = await request(`/api/v1/tools/${name}`, args);
      } catch (error) {
        result = { error: error instanceof Error ? error.message : 'The tool request failed.', ...(executedRequestId ? { requestId: executedRequestId, retryGuidance: 'Reuse this ID if retrying the same request; check job history before creating a new ID.' } : {}) };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  console.log('Stopped after 12 tool rounds. Review the job history before continuing.');
}

try {
  console.log('Connector xAI API client. This developer tool is separate from Grok Bot. It uses the xAI API account connected in the dashboard; separate API billing applies.');
  if (approveWrites) console.log('Unattended writes are enabled for this session.');
  if (oneMessage) await turn(oneMessage);
  else {
    while (true) {
      const prompt = (await rl.question('\nYou: ')).trim();
      if (!prompt || prompt === '/exit') break;
      if (prompt === '/new') { messages.length = 0; console.log('Started a new conversation.'); continue; }
      await turn(prompt);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The xAI API client could not complete the request.');
  process.exitCode = 1;
} finally { rl.close(); }
