# Grok connector protocol

Connector is a single-owner MCP server and authenticated REST pipeline. It uses your own official API app credentials; it is not a Zernio proxy, browser automation extension, or connection to private chat sessions. Configure the custom connector in your existing Grok settings with its public HTTPS endpoint and secret API key. The dashboard's Pipeline page shows endpoint details and the current capability catalog.

## MCP configuration

Use **Streamable HTTP**, URL `https://YOUR_HOST/mcp`, and an `Authorization: Bearer YOUR_PIPELINE_API_KEY` header. Clients that label their credential field API key can use `X-API-Key: YOUR_PIPELINE_API_KEY`. Never place secrets in URL parameters. Example client configuration (replace values securely; do not commit your key):

```json
{
  "mcpServers": {
    "connector": {
      "url": "https://YOUR_HOST/mcp",
      "headers": { "Authorization": "Bearer YOUR_PIPELINE_API_KEY" }
    }
  }
}
```

Client configuration file formats vary. Enter the equivalent URL/credential through Grok's connector settings. The server supports MCP initialization, tool discovery and tool calls over stateless Streamable HTTP POST; it does not implement legacy SSE transport or an OAuth identity-provider service. Use a client supporting API-key/Bearer authentication. Your actual Grok client connection must be tested after deploying the HTTPS host.

| Tool | Purpose |
| --- | --- |
| `list_connections` | Account status, resource preview, and action names. No credentials. |
| `list_actions` | Exact action IDs, field names, descriptions, choices and requirements for one provider. |
| `run_action` | Execute a supported read or write operation. |
| `schedule_post` | Persist a future supported publication. |
| `list_jobs` | Last 100 scheduled jobs and write receipts. |
| `cancel_job` | Cancel a pending publication after confirmation. |

All values in `values` are **strings**, including numbers, dates and boolean choices. Use exact field names and enumerated choices from `list_actions`. The tool result distinguishes an accepted asynchronous upload from a published post. Run the relevant publication-status action before reporting a final platform state.

## Write authorization and retries

The caller must obtain the account owner's authorization for the intended content, target, timing, campaign/budget change, note edit, or conversion event before sending `confirmed: true`. This flag records caller confirmation; it is not independent proof that a human clicked a button in Grok. Use the client's own approval controls when available. The original pipeline API key grants access to the standard platform connections, including WordPress, Mailchimp, and the selected Obsidian vault. Google Workspace uses separate, restricted agent keys described below.

## Google Workspace accounts and agent keys

Open **Google Workspace** in the dashboard, connect each Google account, and create an AI agent profile. Select the permitted apps for each account and optionally choose a default account. Copy that profile's key and the same public `/mcp` URL into a separate Google Workspace connector in the AI client. Keep the original general Connector entry if the agent also uses social media, advertising, or Obsidian.

Google profile keys expose three tools: `list_workspace_accounts`, `list_workspace_actions`, and `run_workspace_action`. Have the agent list its permitted accounts, inspect an app's action schema, then pass the chosen `accountId` when calling an action. If no default exists, an explicit account selection is required. The server checks account and app access on every call; a supplied account ID cannot expand the profile's permissions.

The original key cannot access the new Workspace tools. Workspace profile keys cannot invoke the general platform tools, scheduling endpoints, or optional server-side Grok bot. Changing permissions keeps a profile key valid with its new restrictions; replacing or deleting it removes the old key's access. Each agent can have different accounts and different apps, even on the same connected Google account.

Workspace writes require `confirmed: true` and a `requestId`, using the same retry rules as other writes. Their encrypted receipts are kept separately from the general scheduled-job list. Workspace actions are immediate; native task due dates and meeting-space creation are supported where listed, but generic Workspace scheduling is not provided.

See [Workspace setup](providers-workspace.md) for scopes, app approvals, Maps project keys, and the Voice administrator-report limitation.

Every write and scheduled publication requires a `requestId`: 8–128 letters, digits, hyphens or underscores. Generate a UUID for each intended write and **reuse it on transport retries**. Reusing an ID with different inputs is rejected. A completed identical submission returns its saved result. Running, failed or uncertain immediate writes cannot be rerun under the same ID.

If a request times out or the process restarts mid-write, check the platform and job history before creating another request ID. An upstream service may accept a request even when its response is lost. Connector deliberately does not automatically retry writes.

## Scheduling

Only actions marked `schedulable` can be queued. Supply `scheduledAt` as ISO8601 with a timezone, for example `2026-12-01T09:00:00+08:00`. Schedules must be between 5 seconds and one year in the future. The UI displays times in the browser's locale.

Jobs persist in SQLite and their content is encrypted. The worker checks every 15 seconds and processes up to ten due jobs sequentially per poll. **Keep one Connector instance running with persistent storage.** Pending jobs due during downtime run after restart. Jobs that were running during a crash become `uncertain` and are not replayed. Cancellation is possible only while pending. There is no background platform-native schedule guarantee or exact-second delivery SLA.

Job success means the action returned successfully; the result may say an upload was submitted or a campaign was created paused. Provider-specific moderation, processing and delivery can still fail later. There is no webhook ingestion or background comment/DM polling: the bot requests inbox/report tools when needed.

## REST equivalent

Send `Authorization: Bearer ...` or `X-API-Key: ...` over HTTPS. Endpoints:

| Method and path | Body / purpose |
| --- | --- |
| `GET /api/v1/connections` | Connected accounts and action names |
| `GET /api/v1/actions/PROVIDER` | Exact action schema |
| `POST /api/v1/actions/PROVIDER/ACTION` | `{ "values": {...}, "confirmed": true, "requestId": "UUID" }` (confirmation/id needed only for writes) |
| `POST /api/v1/jobs` | `{ "provider": "...", "action": "...", "values": {...}, "scheduledAt": "...", "confirmed": true, "requestId": "UUID" }` |
| `GET /api/v1/jobs` | Latest jobs/receipts |
| `DELETE /api/v1/jobs/ID` | `{ "confirmed": true }` |
| `POST /api/v1/tools/TOOL_NAME` | Same arguments as the MCP tool |

Example MCP tool arguments for discovery:

```json
{"provider":"facebook"}
```

Use the returned publish action schema to construct the write; fields differ by platform and are validated server-side. This avoids silently applying one platform's target or privacy settings to another.

## Hosting

Deploy the included Docker image behind HTTPS, preserve `/app/data`, set `APP_ORIGIN` to the public origin, and retain `ENCRYPTION_KEY`. Register matching OAuth callback URLs for each platform. The optional Render blueprint needs `APP_ORIGIN`, a 64-hex-character encryption key generated by setup, and your provider app settings supplied securely. The blueprint uses paid persistent hosting and does not run automatically.

Do not publish `.env`, SQLite files, platform credentials or the connector API key to GitHub. Rotation of `PIPELINE_API_KEY` requires updating your bot's connector credential. Rotating `ENCRYPTION_KEY` requires a credential migration or reconnecting accounts; it cannot decrypt data written with the old key.
