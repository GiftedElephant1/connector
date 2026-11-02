# Send tasks from Connector to AI agents

Open **AI connections → Send tasks to AI agents** to send a prompt to an enabled agent and track the task. This is separate from adding Connector's tools inside an AI app: that connection lets the AI call Connector; this feature lets Connector start work in the AI.

| Agent | How Connector starts work | Where to read the result |
| --- | --- | --- |
| Claude | The official Claude Code client signed in on the Connector PC. | Connector's task result. |
| ChatGPT | The official Codex client signed in on the Connector PC. | Connector's task result. |
| Gemini | The official Antigravity CLI (`agy`) signed in on the Connector PC. This does not send a message to Gemini's website/mobile app. | Connector's task result. |
| Cursor | The official Cursor Cloud Agents API, using a key from your Cursor account and an explicitly selected eligible model. | Connector's task result after refreshing the task. |
| Grok Bot | A webhook belonging to a routine you create in your Bot. | Grok Bot's conversation. Connector reports acceptance, not a completed answer. |

Your existing account supplies the agent's model access. Plan eligibility, included usage, rate limits, and any enabled extra usage still apply. The Cursor key and Grok routine key authorize these products; they are not Anthropic, OpenAI, Google model API, or xAI model API keys. Do not enter model-provider keys to enable this workflow.

## Set up an agent

Existing platform connections and incoming AI authorizations remain saved. Each outbound agent is disabled until you enable it. Keep the PC running Connector awake and online to start tasks or collect results.

### Claude, ChatGPT, and Gemini

These three integrations run the providers' official command-line clients on the same PC as Connector. Their one-time installation and account sign-in happen in those clients; an existing website login alone does not configure them. Connector does not install the clients, import browser sessions, or copy subscription credentials.

1. Install the official client for the intended account: **Claude Code** for Claude, **Codex** for ChatGPT, or **Antigravity CLI** for Gemini. Follow the linked official installation and sign-in guide on that agent's setup card.
2. Open the installed client once and complete its account sign-in. Choose the subscription/account sign-in option rather than model API-key authentication. Use the Windows account that runs Connector.
3. Return to Connector's **AI connections → Send tasks to AI agents** section and open that agent's setup.
4. Leave the executable path blank for automatic discovery. If Connector cannot find the installed client, enter the full path to the official executable in the setup field; do not paste a shell command or command-line arguments there.
5. Click **Save outbound setup**, then **Check readiness**. Follow any reported installation or sign-in instruction. A detected executable alone does not prove that an account is signed in or has usage available.
6. Select **Enable [agent] task sending**, save the setup again, then send a short task as described below. An actual successful task checks the account's access.

Use the official setup for each client:

- **Claude:** install [Claude Code](https://code.claude.com/docs/en/setup), then run `claude auth login` and complete the browser sign-in for your eligible Claude account.
- **ChatGPT:** install [Codex](https://developers.openai.com/codex/cli), then run `codex login` and choose **Sign in with ChatGPT** for your account.
- **Gemini:** install [Antigravity CLI](https://antigravity.google/docs/install?tab=cli), then run `agy` once and complete its interactive Google account sign-in. Antigravity stores sign-in through its official credential system; Connector does not copy those credentials. Review Antigravity's credit/overage settings and turn off extra credits if you want to stay within your plan's allowance.

After installing a client, restart Connector so it can discover the new executable. These commands are one-time account setup, not a request to create a model API developer account.

Local tasks use a temporary working folder and a restricted text-task configuration. Connector does not automatically give these subprocesses your projects, platform credentials, Connector key, Google profiles, or other agents' tools. Send the text needed for the task in the prompt. Their responses are generated text; review them before using them to authorize a platform write.

The **Gemini website/mobile connection** in the incoming AI cards still works as documented in the [AI connection guide](ai-connections.md#gemini-website-and-mobile-app). Sending an outbound Gemini task here uses Antigravity CLI, a separate product route with its own account eligibility. It does not insert a conversation into the Gemini website or mobile app.

### Cursor

1. Sign in to the Cursor account whose plan and usage you intend to use.
2. Open [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api). Create a key for Connector and copy it while Cursor displays it. Follow Cursor's official [Cloud Agents API authentication instructions](https://cursor.com/docs/api#authentication) if the dashboard layout changes.
3. In Connector, open **AI connections → Send tasks to AI agents** and click **Configure Cursor**. Paste the key into the masked Cursor API-key field.
4. Click **Load subscription models** and choose a **Cursor subscription model** from the eligible options. Connector does not choose an arbitrary paid third-party model or silently switch models for you.
5. Click **Save outbound setup**, then **Check readiness**. Select **Enable Cursor task sending** and save again. The check reads model availability; it does not start an agent or guarantee that your remaining plan allowance is sufficient.
6. Send a small task and refresh its status to read the result.

Cursor tasks use a cloud agent without an attached repository. Connector does not forward its platform credentials or automatically install its MCP tools into that agent. Cursor's cloud computer can still have capabilities of its own; approve the exact task you want it to perform. Inspect Cursor's usage settings before enabling extra spending. Selecting an included model does not make usage unlimited or override the account's billing policy.

### Grok Bot

This uses Grok Bot's documented [routine webhook](https://docs.x.ai/grok-bot/skills-routines-and-automations#webhooks), funded by the allowance on your eligible Grok Bot account. It does not call the separately billed xAI model API.

1. Open Grok Bot and choose the Bot that should receive tasks. Confirm its account has access and available usage. If needed, follow [Grok Bot's plan/linking instructions](https://cursor.com/help/grok-bot/plans).
2. Ask that Bot to create a routine with a webhook trigger. Give the routine this instruction, adjusting the approval boundary for your intended work:

   > When this routine receives JSON, use `prompt` as the task I sent from Connector and include its `taskId` in your reply. Report the result in this Bot conversation. Do not repeat a task ID you have already completed. Do not delegate this task back to Connector or retrigger this routine. Ask for approval before publishing, sending messages, deleting, spending money, or changing connected accounts. Report missing access instead of inventing a result.

3. Open the created routine in the Grok Bot desktop app. Find its **Webhook** section and confirm the routine is active.
4. Click **POST to** to copy the exact webhook URL. In Connector, click **Configure Grok Bot** and paste it into the webhook URL field.
5. Return to the routine, click **key**, and paste the copied value into Connector's masked webhook-key field. Copy the key itself, not the full **header** value. This secret belongs to the routine; it is not your Grok password, Connector API key, or xAI developer API key.
6. Select **Enable Grok Bot task sending** and click **Save outbound setup**. The settings check validates the address and key format without starting a run. A real task is the acceptance test and consumes Bot usage.
7. Send a small task from Connector. When Connector shows **Submitted**, open the Bot's conversation and find the reply with the matching task ID.

Connector sends one HTTP POST with `Authorization: Bearer <routine-key>` and a JSON body containing `{ "taskId": "...", "prompt": "..." }`. The JSON field names are this app's convention; the routine instruction tells the Bot how to use them. HTTP **200** means the routine accepted the request and started, not that it finished. Connector does not fetch the Bot's final reply or pretend that acknowledgement is an answer.

Use the URL shown by your own routine. Connector permits public HTTPS destinations, checks DNS answers, and pins the checked address for the connection; private/local networks and redirects are rejected. URL and key are stored encrypted and are not returned by the settings API. No test or retry is sent automatically when saving credentials.

Grok Bot's webhook has no documented cancellation operation. Manage an accepted run inside Grok Bot. Stopping Connector, revoking an AI grant, disabling this outbound setup, or losing the network connection does not stop a routine that Grok Bot already received. Each routine run spends account usage; review its schedule, triggers, and on-demand settings if usage is higher than expected.

## Send a task and read its status

1. Open **AI connections → Send tasks to AI agents**.
2. In **New AI task**, choose a configured, enabled agent under **Send task to**.
3. Enter a clear prompt under **Task instructions**, up to 16,000 characters. For a first test, use: **“Reply with one sentence confirming you received this text task. Do not use tools or change anything.”**
4. Review the selected agent and exact prompt. Confirm that you want to start this task and use that account's allowance, then click **Send task**.
5. Click **Refresh AI tasks** until it finishes or reports an issue. Open its task details to read the result. For Grok Bot, **Submitted** is the final acknowledgement shown here; read its answer in the Bot conversation.

| Task state | Meaning |
| --- | --- |
| Running | Connector is starting the task or the agent is still working. |
| Succeeded | A local client or Cursor reported a completed result. Review the returned text. |
| Submitted | Grok Bot accepted its webhook. Completion and the answer must be checked in Grok Bot. |
| Cancelled | The supported local process or remote agent confirmed cancellation. This does not undo actions already performed. |
| Failed | The provider reported a failure; read the task error before deciding what to do next. |
| Result uncertain | Connector could not establish the outcome. Check the provider before starting a replacement task. |

Where cancellation is supported, click **Cancel task**, then **Confirm cancel task**. Cancellation is best effort and cannot undo completed work. A timeout or crash can occur after a provider accepted a task; Connector does not automatically resubmit it. The task ID identifies the saved receipt, while callers' request IDs prevent an identical transport retry from starting the task twice.

## Let another AI delegate tasks

Starting work in another AI can consume usage and share the prompt with that provider. Outbound delegation is an additional permission; existing incoming AI connections do not gain it automatically.

1. Enable and verify the outbound agents you want to offer.
2. For an incoming OAuth AI connection, authorize a new connection and check **Send tasks to AI agents** on Connector's approval screen. Leave this option unchecked for clients that should only use their existing platform or Google tools. Review the other access options before approving.
3. For a client using the shared general Connector key, expand **Let an incoming AI agent send tasks to other AI agents**, check **Allow the shared Connector key to send AI tasks**, and click **Save shared-key access** only if every holder of that key should receive this capability. Workspace profile keys do not grant outbound delegation.
4. Ask the calling AI to list available agents before choosing one. Approve the exact destination agent and task before it starts work.

The calling AI receives a task receipt and can check that task later. Its task history is isolated from other incoming AI connections; the owner can see all tasks in the dashboard. Existing grants, Google account/app restrictions, and platform credentials remain unchanged. Disabling delegation blocks future authorized access; cancel already-running tasks separately where supported.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| A local client is unavailable | Install the current official client under the Windows user running Connector, restart Connector, or enter its full executable path. The field accepts an executable path, not an installer or shell command. |
| Claude or Codex needs sign-in | Complete the official client's subscription sign-in. An API-key login is not accepted for this route. Website sign-in alone does not sign in the local client. |
| Antigravity is installed but sign-in is unverified | Its readiness check does not spend model usage to test authentication. Run `agy` once for account sign-in, then approve a small task to test actual access. |
| Antigravity reports customizations or a billing mode it cannot use | The runner rejects model API/ADC mode, enabled AI Credit Overages, and global hooks, MCP servers, plugins, skills, rules, startup scripts, or instructions that could change the isolated task. Review the named setting in Antigravity and use a configuration without those customizations. Connector does not delete them or weaken its restrictions automatically. |
| A local client rejects a command option | Update the official client. Connector requires its supported isolation controls and does not retry with a weaker configuration. |
| Cursor offers no eligible models | Check the account, subscription, and returned model list. Connector does not fall back to an unlisted or separately billed model. |
| Grok reports Submitted but has no answer here | Submission acknowledgement is expected. Open the Bot's conversation and find the matching task ID. |
| A task is Result uncertain | Check the provider and existing receipt. A new task can duplicate work and usage if the first submission was accepted. |
| Another AI cannot delegate | Check its separate outbound OAuth permission or the owner's shared-key delegation setting, then refresh that client's tool list. Existing platform access is not delegation permission. |

See the [tool contract](pipeline.md#outbound-ai-task-tools) for schemas, request IDs, and retry behavior. Provider sign-in, account usage, and a real task must still be checked on your PC; automated tests do not establish live access to your subscriptions.
