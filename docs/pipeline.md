# AI connector protocol

Connector is a single-owner MCP server and authenticated REST pipeline. An AI app uses Connector's tools to act on destination accounts you have connected. The default AI connection uses OAuth with compatible MCP clients, including supported Claude and ChatGPT configurations; it does not call those providers' model APIs or require their developer keys. For Grok Bot, the dashboard prepares a message with the public endpoint and connection instructions; verify a real MCP tool call using its [setup guide](ai-connections.md#grok-bot). Destination platforms still use their own official API credentials and permissions.

Open **AI connections** for guided setup, the public endpoint, and access revocation. Follow [the AI connection guide](ai-connections.md) for click-by-click instructions. The protocol details below are for administrators and custom clients.

## MCP configuration

Use **Streamable HTTP**, URL `https://YOUR_HOST/mcp`, and **OAuth** authentication. The server publishes OAuth discovery metadata and supports dynamic client registration, authorization code flow with PKCE S256, and refresh tokens. A compatible client registers and exchanges credentials automatically; you do not create an Anthropic, OpenAI, or xAI developer application or manually register guessed callback URLs.

The owner approves access with the Connector workspace password. The consent screen offers **Standard platform tools** and/or one **Google Workspace agent profile**. Standard access includes all standard connected platforms and future additions; it is not a per-platform grant. Google access is limited to the selected profile's accounts and apps. OAuth credentials do not grant access to the owner dashboard.

The server supports MCP initialization, tool discovery, and tool calls over stateless Streamable HTTP POST. It does not implement legacy SSE transport. Public HTTPS access must remain available; a hosted AI client cannot reach a PC's loopback address. Tests verify server behavior, while a live connection in the chosen AI app verifies that account's client support and plan eligibility.

Access tokens expire within one hour; compatible clients refresh them automatically when `offline_access` was granted. The authorization has a 30-day maximum lifetime, after which the owner must approve that AI again. Destination accounts remain connected. Changing the public origin invalidates grants issued for the previous endpoint. **Approved AI connections** shows authorization expiry and records a successful MCP tool call separately from consent, so an approved grant alone is not reported as a tested client connection.

### Advanced key authentication

Existing key-based integrations continue to work. Use an `Authorization: Bearer YOUR_PIPELINE_API_KEY` header, or `X-API-Key: YOUR_PIPELINE_API_KEY` in clients offering that field. These are **Connector-generated keys**, not AI provider API keys. Never place secrets in URL parameters. Example client configuration (replace values securely; do not commit your key):

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

Client configuration file formats vary. Reveal the general key under **AI connections → Advanced: connect with a Connector API key**. The general key permits standard platform tools; Workspace profile keys permit only their assigned Google accounts and apps. OAuth can combine both groups into a single connection without exposing either long-lived key to the client.

### Standard platform tools

These tools are available to OAuth grants with standard access and to the general connector key:

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

The caller must obtain the account owner's authorization for the intended content, target, timing, campaign/budget change, note edit, or conversion event before sending `confirmed: true`. This flag records caller confirmation; it is not independent proof that a human clicked a button in the AI client. Use the client's own approval controls when available. OAuth consent grants tool access; it does not replace approval of an individual write. Standard access includes WordPress, Mailchimp, and the selected Obsidian vault. Google Workspace has the additional profile restrictions described below.

Every write and scheduled publication requires a `requestId`: 8–128 letters, digits, hyphens or underscores. Generate a UUID for each intended write and **reuse it on transport retries**. Reusing an ID with different inputs is rejected. A completed identical submission returns its saved result. Running, failed or uncertain immediate writes cannot be rerun under the same ID.

If a request times out or the process restarts mid-write, check the platform and job history before creating another request ID. An upstream service may accept a request even when its response is lost. Connector deliberately does not automatically retry writes.

## Google Workspace accounts and agent profiles

Open **Google Workspace**, connect each Google account, and create an AI agent profile. Select the permitted apps for each account and optionally choose a default account. Select that profile on the AI OAuth consent screen. One connection can include both the selected profile and standard platform tools. Leave the profile unselected when an AI should have no Workspace access.

Workspace access exposes three tools: `list_workspace_accounts`, `list_workspace_actions`, and `run_workspace_action`. Have the agent list its permitted accounts, inspect an app's action schema, then pass the chosen `accountId` when calling an action. If no default exists, an explicit account selection is required. The server checks the profile's current account and app permissions on every call; a supplied account ID cannot expand them. Each AI agent can use a different profile, including different apps on the same connected Google account.

Legacy profile keys remain supported. Copy a profile's key and the same `/mcp` URL into a separate key-authenticated connector entry. A profile key cannot invoke standard platform tools, scheduling endpoints, or the optional server-side xAI API client endpoint. The general key cannot invoke Workspace tools. For key-only clients using both, retain two connector entries. Profile edits apply to both OAuth and key access; deleting a profile invalidates keys and OAuth grants that depended on it, including standard access within a combined grant. Rotating its API key invalidates that key, while OAuth grants are revoked separately in **AI connections**.

Workspace writes require `confirmed: true` and a `requestId`, using the same retry rules as other writes. Their encrypted receipts are kept separately from the general scheduled-job list. Workspace actions are immediate; native task due dates and meeting-space creation are supported where listed, but generic Workspace scheduling is not provided.

See [Workspace setup](providers-workspace.md) for Google scopes, app approvals, Maps project keys, and the Voice administrator-report limitation.

## Revoke an AI connection

Open **AI connections → Approved AI connections**, select the grant's revoke control, and confirm. Future requests using that OAuth grant are denied; other AI grants and the connected platform accounts remain intact. The original general API key and Workspace profile keys have separate lifecycles and are not revoked by deleting an OAuth grant.

Revocation does not undo completed actions or cancel already-approved scheduled publications. Cancel unwanted pending jobs separately in **Schedule** before removing access if needed. Changing the approved standard/Workspace combination requires a new OAuth authorization; changing accounts or apps within a selected Workspace profile takes effect through the profile's current restrictions.

## Scheduling

Only actions marked `schedulable` can be queued. Supply `scheduledAt` as ISO8601 with a timezone, for example `2026-12-01T09:00:00+08:00`. Schedules must be between 5 seconds and one year in the future. The UI displays times in the browser's locale.

Jobs persist in SQLite and their content is encrypted. The worker checks every 15 seconds and processes up to ten due jobs sequentially per poll. **Keep one Connector instance running with persistent storage.** Pending jobs due during downtime run after restart. Jobs that were running during a crash become `uncertain` and are not replayed. Cancellation is possible only while pending. There is no background platform-native schedule guarantee or exact-second delivery SLA.

Job success means the action returned successfully; the result may say an upload was submitted or a campaign was created paused. Provider-specific moderation, processing and delivery can still fail later. There is no webhook ingestion or background comment/DM polling: the bot requests inbox/report tools when needed.

## REST equivalent

REST clients use the existing general Connector key or an appropriate Workspace profile key in `Authorization: Bearer ...` or `X-API-Key: ...` over HTTPS. OAuth AI access tokens are restricted to `/mcp` and cannot be used for these REST endpoints. Standard platform endpoints:

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
