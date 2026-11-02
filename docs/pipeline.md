# AI connector protocol

Connector is a single-owner MCP server and authenticated REST pipeline. An AI app uses Connector's tools to act on destination accounts you have connected. The default AI connection uses OAuth with compatible MCP clients, including supported Claude, ChatGPT, Gemini Apps, and Cursor configurations; it does not call those providers' model APIs or require their developer keys. For Grok Bot, the dashboard prepares instructions for authenticated HTTPS REST requests from its cloud computer; follow the [setup guide](ai-connections.md#grok-bot) and verify an actual account-list response. Destination platforms still use their own official API credentials and permissions.

Open **AI connections** for guided setup, the public endpoint, and access revocation. Follow [the AI connection guide](ai-connections.md) for click-by-click instructions. The protocol details below are for administrators and custom clients.

Connector can also start tasks in configured AI agents. This requires separate outbound setup and delegation permission; approving an AI to use platform tools does not grant it that permission. See [Send tasks from Connector to AI agents](outbound-ai.md) for Claude Code, Codex, Gemini through Antigravity, Cursor Cloud Agents, and Grok Bot routines.

## MCP configuration

Use **Streamable HTTP**, URL `https://YOUR_HOST/mcp`, and **OAuth** authentication. The server publishes OAuth discovery metadata and supports dynamic client registration, authorization code flow with PKCE S256, and refresh tokens. A compatible client registers and exchanges credentials automatically; you do not create a model-provider developer application or manually register guessed callback URLs. Gemini Apps uses its custom-app setup; Cursor supports the remote URL in `mcpServers.connector.url`. Follow the client-specific [setup steps](ai-connections.md) instead of adding a model API key.

The owner approves access with the Connector workspace password. The consent screen offers **Standard platform tools**, one **Google Workspace agent profile**, and the separate **Send tasks to AI agents** option. Standard access includes all standard connected platforms and future additions; it is not a per-platform grant. Google access is limited to the selected profile's accounts and apps. Outbound delegation is off unless explicitly selected; old grants do not gain it during an update. OAuth credentials do not grant access to the owner dashboard.

The server supports MCP initialization, tool discovery, and tool calls over stateless Streamable HTTP POST. It does not implement legacy SSE transport. Public HTTPS access must remain available; a hosted AI client cannot reach a PC's loopback address. Tests verify server behavior, while a live connection in the chosen AI app verifies that account's client support and plan eligibility.

Access tokens expire within one hour; compatible clients refresh them automatically when `offline_access` was granted. The authorization has a 30-day maximum lifetime, after which the owner must approve that AI again. Destination accounts remain connected. Changing the public origin invalidates grants issued for the previous endpoint. **Approved AI connections** shows authorization expiry and records a successful MCP tool call separately from consent, so an approved grant alone is not reported as a tested client connection.

The owner can explicitly enable or disable **AI delegation** on an existing live grant in **Approved AI connections**. This preserves its tokens, standard platform access, and Google profile; the permission change takes effect on subsequent calls without reconnecting. Disabling delegation does not cancel work already started. The shared-key delegation setting is separate and does not modify OAuth grants.

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

## Outbound AI task tools

These tools start work in an AI client rather than list an AI app's permission to call Connector. The owner configures and enables providers under **AI connections → Send tasks to AI agents**. OAuth clients need an explicit outbound grant. Clients using the general Connector key need the owner's separate shared-key delegation switch enabled; Workspace profile keys do not receive these tools.

| Tool | Arguments and result |
| --- | --- |
| `list_ai_agents` | `{}`; reports configured/enabled providers, execution mode, result availability, and cancellation support without credentials. |
| `check_ai_agent` | `{ "provider": "gemini" }`; checks an enabled agent’s installation, sign-in or configuration without sending a model task or starting a routine. Returns safe readiness diagnostics. |
| `start_ai_task` | `{ "provider": "claude", "prompt": "...", "confirmed": true, "requestId": "UUID" }`; creates and immediately returns a task receipt. Provider IDs: `claude`, `chatgpt`, `gemini`, `cursor`, `grok`. |
| `get_ai_task` | `{ "id": "TASK_ID" }`; reads status/result and refreshes a known Cursor run. |
| `list_ai_tasks` | `{}`; lists this calling connection's most recent 100 task receipts. |
| `cancel_ai_task` | `{ "id": "TASK_ID", "confirmed": true }`; requests supported local/Cursor cancellation. Grok routine webhooks do not provide cancellation. |

### Existing connection and action tools

Clients can also use `list_connections`, `list_actions`, and `run_action` for the same tasks. `connections` includes `connectionType: "outbound_ai"` entries for `claude`, `chatgpt`, `gemini`, `cursor`, and `grok`, with status and action IDs. `enabled` describes saved setup, not a successful task. A caller lacking delegation permission receives `authorization_required`; advertising the action names does not authorize execution. OAuth callers without delegation permission receive no private destination setup or readiness details. OAuth grants with only outbound access receive these three tools restricted to AI destinations, plus the dedicated task tools.

Call `list_actions` with the destination ID before constructing a request. Then use `run_action` with that provider and an action from the returned definitions:

| Action | `values` and behavior |
| --- | --- |
| `check-connection` | `{}`; checks readiness without sending a model task. |
| `start-task` | `{ "prompt": "..." }`, with top-level `confirmed: true` and `requestId`; returns the saved task receipt. |
| `get-task` | `{ "id": "TASK_ID" }`; refreshes status and returns the result when available. |
| `list-tasks` | `{}`; lists this caller's recent tasks for the destination. |
| `cancel-task` | `{ "id": "TASK_ID" }`, with top-level `confirmed: true`; offered for supported local/Cursor cancellation. |

The established and dedicated tools share permissions, task ownership, and request-ID deduplication. Reuse the same `requestId` and inputs when retrying a submission through either interface; use the returned task `id` for later reads. Provider aliases `claude-code`, `codex`, and `antigravity` resolve to `claude`, `chatgpt`, and `gemini`. The developer integrations `anthropic`, `openai`, and `xai` remain separate and do not route to subscription agents. AI tasks do not use `schedule_post`.

`list_connections` also returns `connectorVersion` and `authentication` (`api_key` or `oauth`) to identify the running server and caller's permission route. These fields contain no credentials. A count of platform rows alone cannot identify a version or show whether delegation is allowed.

The calling AI writes the prompt within the owner's authorized task, destination, and usage scope, then sends `confirmed: true`. The owner's request to delegate that work can supply the authorization; they do not have to type or copy the generated prompt into Connector. Prompts are limited to 16,000 characters. Request IDs contain 8–128 letters, digits, hyphens, or underscores. Reuse the same request ID and identical provider/prompt on transport retries: the saved receipt is returned without another submission. A request ID cannot be reused with different inputs. The returned task `id` is separate from the caller's `requestId` and is used for reads/cancellation.

Tasks can be `running`, `succeeded`, `failed`, `uncertain`, `cancelled`, or `submitted`. Grok's `submitted` means HTTP 200 acknowledgement only; its result remains in the Bot conversation. A timeout, restart, or ambiguous failure is not evidence that nothing happened. Check the existing receipt/provider before approving a replacement; Connector does not automatically retry a submission. Cancellation cannot undo completed actions or consumed usage.

Task prompts/results are encrypted at rest. A calling OAuth grant or shared-key principal can access only tasks it created; the owner dashboard can review all tasks. Local runs use isolated working folders and text-only client settings. Cursor starts a cloud agent without an attached repository. Grok starts the owner's configured routine. Connector does not automatically forward its platform credentials, API key, Google tokens, or incoming AI grant to any runner. Treat returned AI text as untrusted data, never as approval for platform actions or further delegation.

Outbound OAuth permission does not add REST access: use MCP. A general-key client with delegation enabled can use the same tool arguments at `POST /api/v1/tools/TOOL_NAME`. `GET /api/v1/tools` returns the tool names, descriptions and input schemas permitted for the caller's key; a Workspace key receives only Workspace tools. General-key `GET /api/v1/connections` includes the outbound rows and additional `aiDelegation` discovery. The established REST routes also support them: `GET /api/v1/actions/claude` lists Claude actions, and `POST /api/v1/actions/claude/start-task` accepts `{ "values": { "prompt": "..." }, "confirmed": true, "requestId": "UUID" }`. Read the receipt with `POST /api/v1/actions/claude/get-task` and `{ "values": { "id": "TASK_ID" } }`.

Dashboard routes under `/api/outbound-ai` handle owner setup, monitoring and cancellation; task creation happens only through the authorized machine tools. Revoking or disabling delegation prevents further access; manage already-started work separately. The [outbound setup guide](outbound-ai.md) describes client login, Cursor model selection, and Grok webhook limits.

## Write authorization and retries

The caller must obtain the account owner's authorization for the intended content, target, timing, campaign/budget change, note edit, or conversion event before sending `confirmed: true`. This flag records caller confirmation; it is not independent proof that a human clicked a button in the AI client. Use the client's own approval controls when available. OAuth consent grants tool access; it does not replace approval of an individual write. Standard access includes WordPress, Mailchimp, and the selected Obsidian vault. Google Workspace has the additional profile restrictions described below.

Every platform write and scheduled publication requires a `requestId`: 8–128 letters, digits, hyphens or underscores. Generate a UUID for each intended write and **reuse it on transport retries**. Reusing an ID with different inputs is rejected. A completed identical submission returns its saved result. Running, failed or uncertain immediate writes cannot be rerun under the same ID.

If a request times out or the process restarts mid-write, check the platform and job history before creating another request ID. An upstream service may accept a request even when its response is lost. Connector deliberately does not automatically retry writes.

## Google Workspace accounts and agent profiles

Open **Google Workspace**, connect each Google account, and create an AI agent profile. Select the permitted apps for each account and optionally choose a default account. Select that profile on the AI OAuth consent screen. One connection can include both the selected profile and standard platform tools. Leave the profile unselected when an AI should have no Workspace access.

Workspace access exposes three tools: `list_workspace_accounts`, `list_workspace_actions`, and `run_workspace_action`. Have the agent list its permitted accounts, inspect an app's action schema, then pass the chosen `accountId` when calling an action. If no default exists, an explicit account selection is required. The server checks the profile's current account and app permissions on every call; a supplied account ID cannot expand them. Each credential can be assigned a different profile, including different apps on the same connected Google account. Grok Bot shares one cloud computer and credentials across all Bots on an account: these restrictions apply per credential and cannot isolate Bots that can access one another's credentials.

Legacy profile keys remain supported. Copy a profile's key and the same `/mcp` URL into a separate key-authenticated connector entry. A profile key cannot invoke standard platform tools, scheduling endpoints, or the optional server-side xAI API client endpoint. The general key cannot invoke Workspace tools. For key-only MCP clients using both, retain two connector entries. REST clients use the appropriate key for each request. Profile edits apply to both OAuth and key access; deleting a profile invalidates keys and OAuth grants that depended on it, including standard access within a combined grant. Rotating its API key invalidates that key, while OAuth grants are revoked separately in **AI connections**.

Workspace writes require `confirmed: true` and a `requestId`, using the same retry rules as other writes. Their encrypted receipts are kept separately from the general scheduled-job list. Workspace actions are immediate; native task due dates and meeting-space creation are supported where listed, but generic Workspace scheduling is not provided.

See [Workspace setup](providers-workspace.md) for Google scopes, app approvals, Maps project keys, and the Voice administrator-report limitation.

### Expanded Workspace API actions

Refresh `list_workspace_accounts` and `list_workspace_actions` after updating Connector and before reporting that a feature is unavailable. Account results include `missingPermissions` by app. Action definitions include required/missing scopes and availability; listing an action does not grant access to it. Approve additional permissions through **Google Workspace → Change connected apps → Continue to Google**, keeping the same account and intended apps. The installed app, the account's actual Google grant, its file/resource permissions, and the agent profile all matter.

Sheets, Docs, Slides, Gmail, Drive, Meet, Chat, and Tasks expose `read-api` and `write-api` for their documented user APIs. Each destination is fixed:

| App | API base (relative paths start with `/`) |
| --- | --- |
| `sheets` | `https://sheets.googleapis.com/v4` |
| `docs` | `https://docs.googleapis.com/v1` |
| `slides` | `https://slides.googleapis.com/v1` |
| `gmail` | `https://gmail.googleapis.com/gmail/v1/users/me` |
| `drive` | `https://www.googleapis.com/drive/v3` |
| `meet` | `https://meet.googleapis.com/v2` |
| `chat` | `https://chat.googleapis.com/v1` |
| `tasks` | `https://tasks.googleapis.com/tasks/v1` |

`read-api` performs GET and takes `path` plus optional `queryJson`. `write-api` also takes `method` (`POST`, `PUT`, `PATCH`, or `DELETE`) and optional `bodyJson`. Every `values` entry is a string: encode the query/body objects as JSON strings. Query values can be scalars or arrays of scalars; arrays produce repeated query keys. Put queries in `queryJson`, never in `path`. Supply only relative paths, not external URLs or authentication headers. Google tokens stay on Connector.

Queries are limited to 10,000 UTF-8 bytes and bodies to 500,000 UTF-8 bytes. JSON responses are limited to 1 MiB, returned as `result.items[0].responseJson` with HTTP status and method. Use Google's `fields`, ranges, page sizes, and page tokens to keep responses bounded. Responses above the limit fail explicitly rather than silently truncating. If a write response is lost or too large, inspect the destination before retrying: Google may already have applied the write. Media uses the dedicated Drive upload/download/export actions, not these JSON-only actions.

For example, this `run_workspace_action` call formats existing text in a Google Doc. Replace the account/document IDs, inspect the document's actual indexes first, and obtain authorization before sending it:

```json
{
  "app": "docs",
  "action": "write-api",
  "accountId": "DISCOVERED_ACCOUNT_ID",
  "values": {
    "path": "/documents/DOCUMENT_ID:batchUpdate",
    "method": "POST",
    "bodyJson": "{\"requests\":[{\"updateTextStyle\":{\"range\":{\"startIndex\":1,\"endIndex\":6},\"textStyle\":{\"bold\":true},\"fields\":\"bold\"}}]}"
  },
  "confirmed": true,
  "requestId": "GENERATE_A_UNIQUE_REQUEST_ID"
}
```

The actions use the selected user's identity. They do not add service-account impersonation or domain-wide delegation. Gmail settings that require delegation, Chat app-only/admin-only/import-mode APIs, joining Meet calls, Calendar invitations, personal Google Voice calls/messages, and Maps personal saved places remain outside this connection. Account roles, subscriptions, and enabled APIs still apply.

### Calculate Sheets formulas

Use `write-formulas`, or `write-values` with `valueInputOption="USER_ENTERED"`. The existing default `RAW` deliberately treats formula-like strings as text. The dedicated action below writes a calculated total:

```json
{
  "app": "sheets",
  "action": "write-formulas",
  "accountId": "DISCOVERED_ACCOUNT_ID",
  "values": {
    "spreadsheetId": "SPREADSHEET_ID",
    "range": "Summary!B10",
    "values": "[[\"=SUM(B2:B9)\"]]"
  },
  "confirmed": true,
  "requestId": "GENERATE_A_UNIQUE_REQUEST_ID"
}
```

Then call `read-values` for the same range with `valueRenderOption="UNFORMATTED_VALUE"` to verify the calculated value, or `FORMULA` to inspect the formula itself. Discover `read-spreadsheet`, `add-tab`, `rename-tab`, `format-cells`, and `batch-update` for tab structure, formatting, charts, and other official Sheets requests. Numeric tab `sheetId` values differ from the document's `spreadsheetId`.

## Revoke an AI connection

Open **AI connections → Approved AI connections**, select the grant's revoke control, and confirm. Future requests using that OAuth grant are denied; other AI grants and the connected platform accounts remain intact. The original general API key and Workspace profile keys have separate lifecycles and are not revoked by deleting an OAuth grant.

Revocation does not undo completed actions or cancel already-approved scheduled publications. Cancel unwanted pending jobs separately in **Schedule** before removing access if needed. Changing the approved standard/Workspace combination requires a new OAuth authorization; changing accounts or apps within a selected Workspace profile takes effect through the profile's current restrictions.

## Scheduling

Only actions marked `schedulable` can be queued. Supply `scheduledAt` as ISO8601 with a timezone, for example `2026-12-01T09:00:00+08:00`. Schedules must be between 5 seconds and one year in the future. The UI displays times in the browser's locale.

Jobs persist in SQLite and their content is encrypted. The worker checks every 15 seconds and processes up to ten due jobs sequentially per poll. **Keep one Connector instance running with persistent storage.** Pending jobs due during downtime run after restart. Jobs that were running during a crash become `uncertain` and are not replayed. Cancellation is possible only while pending. There is no background platform-native schedule guarantee or exact-second delivery SLA.

Job success means the action returned successfully; the result may say an upload was submitted or a campaign was created paused. Provider-specific moderation, processing and delivery can still fail later. There is no webhook ingestion or background comment/DM polling: the bot requests inbox/report tools when needed.

## REST equivalent

REST clients use the existing general Connector key or an appropriate Workspace profile key in `Authorization: Bearer ...` or `X-API-Key: ...` over HTTPS. OAuth AI access tokens are restricted to `/mcp` and cannot be used for these REST endpoints. Key-authenticated REST calls do not create OAuth grants or update their **Last successful tool call** field. Check the actual authenticated response to verify the connection. Grok Bot's cloud terminal can make these requests; transfer keys only through its secure secret request or a masked takeover prompt, not chat. All Bots on the same Grok Bot account share the computer and credentials.

Standard platform endpoints:

| Method and path | Body / purpose |
| --- | --- |
| `GET /api/v1/connections` | Connected accounts and action names |
| `GET /api/v1/actions/PROVIDER` | Exact action schema |
| `POST /api/v1/actions/PROVIDER/ACTION` | `{ "values": {...}, "confirmed": true, "requestId": "UUID" }` (confirmation/id needed only for writes) |
| `POST /api/v1/jobs` | `{ "provider": "...", "action": "...", "values": {...}, "scheduledAt": "...", "confirmed": true, "requestId": "UUID" }` |
| `GET /api/v1/jobs` | Latest jobs/receipts |
| `DELETE /api/v1/jobs/ID` | `{ "confirmed": true }` |
| `POST /api/v1/tools/TOOL_NAME` | Same arguments as the MCP tool |

Workspace endpoints require a **Workspace profile key**, not the general key:

| Method and path | Body / purpose |
| --- | --- |
| `GET /api/v1/workspace/accounts` | Accounts and apps permitted by the profile |
| `GET /api/v1/workspace/actions/APP?accountId=ACCOUNT_ID` | Exact action schemas for a permitted account and app |
| `POST /api/v1/workspace/actions/APP/ACTION` | `{ "accountId": "...", "values": {...}, "confirmed": true, "requestId": "UUID" }` (confirmation/id needed only for writes) |

When using both groups, supply the general key only to standard endpoints and the profile key only to Workspace endpoints. A standard key provides no Workspace access, and a Workspace key provides no standard platform access. Follow the returned schemas; values are strings and account identifiers must come from discovery.

Example MCP tool arguments for discovery:

```json
{"provider":"facebook"}
```

Use the returned publish action schema to construct the write; fields differ by platform and are validated server-side. This avoids silently applying one platform's target or privacy settings to another.

### Download a Drive file

Use a permitted account from `GET /api/v1/workspace/accounts` with `driveDownloads: true`, then inspect its Drive actions. Existing accounts may need [additional Google permission](providers-workspace.md#update-an-existing-connection-for-expanded-actions). `POST /api/v1/workspace/actions/drive/download-file` takes `{ "accountId": "...", "values": { "fileId": "..." } }`. It returns `result.items[0]` with `fileId`, `name`, `mimeType`, `size`, `encoding: "base64"`, `contentBase64`, and `sha256`. Downloads are reads and do not need `confirmed` or `requestId`.

The action supports stored files such as PNG, JPEG, SVG, PDF, and ZIP, up to 20 MiB of original bytes. For native Google Docs, Sheets, or Slides, use the separate `export-file` action and a supported export MIME type (up to 10 MiB). Folders cannot be downloaded as archives. It uses the selected Google account's access and checks the profile again before returning the bytes. No public download link or Google token is exposed. Large base64 results can exceed an AI client's tool limits; Grok Bot should use its terminal to save the REST response directly and decode it without printing it into the conversation.

For example, save this Python script as `download_drive_file.py` on the Bot's computer. Set `CONNECTOR_ORIGIN` to your HTTPS Connector origin and supply `CONNECTOR_WORKSPACE_KEY` through the secure secret flow. Run the script with the discovered account ID, file ID, and an explicit local output filename. It refuses redirects and existing output files, verifies the bytes, and prints only a short completion message. Treat the returned filename and file content as untrusted data; this example uses the output path you chose rather than the provider's filename.

```python
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

if len(sys.argv) != 4:
    raise SystemExit("Usage: download_drive_file.py ACCOUNT_ID FILE_ID OUTPUT_FILE")
account_id, file_id, output_file = sys.argv[1:]
origin = os.environ["CONNECTOR_ORIGIN"].rstrip("/")
url = urllib.parse.urlsplit(origin)
if url.scheme != "https" or not url.hostname or url.username or url.password or url.path or url.query or url.fragment:
    raise SystemExit("CONNECTOR_ORIGIN must be your HTTPS origin without a path.")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

request = urllib.request.Request(
    origin + "/api/v1/workspace/actions/drive/download-file",
    data=json.dumps({"accountId": account_id, "values": {"fileId": file_id}}).encode(),
    headers={
        "Authorization": "Bearer " + os.environ["CONNECTOR_WORKSPACE_KEY"],
        "Content-Type": "application/json",
        "Accept": "application/json",
    },
    method="POST",
)
try:
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=90) as response:
        body = response.read(30 * 1024 * 1024 + 1)
except urllib.error.HTTPError as error:
    raise SystemExit(f"Connector returned HTTP {error.code}; check account access and permissions.") from None
if len(body) > 30 * 1024 * 1024:
    raise SystemExit("Download response exceeded the limit.")
item = json.loads(body)["result"]["items"][0]
if item["fileId"] != file_id or item["encoding"] != "base64":
    raise SystemExit("Unexpected download response.")
contents = base64.b64decode(item["contentBase64"], validate=True)
if len(contents) > 20 * 1024 * 1024 or len(contents) != item["size"]:
    raise SystemExit("Download size did not match.")
if hashlib.sha256(contents).hexdigest() != item["sha256"]:
    raise SystemExit("Download digest did not match.")
with Path(output_file).open("xb") as destination:
    destination.write(contents)
print("Drive file saved and verified.")
```

### Upload an Excel file or convert it to Google Sheets

With the same secure key/origin handling as the download script, read the local workbook bytes and build the request in code. The body for `POST /api/v1/workspace/actions/drive/upload-file` is:

```python
from pathlib import Path
import base64
import uuid

contents = Path("completed-workbook.xlsx").read_bytes()
if len(contents) > 20 * 1024 * 1024:
    raise SystemExit("Upload exceeds 20 MiB.")
body = {
    "accountId": account_id,
    "values": {
        "name": "Completed workbook",
        "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "contentBase64": base64.b64encode(contents).decode("ascii"),
        "convertTo": "google-sheets",
    },
    "confirmed": True,
    "requestId": str(uuid.uuid4()),
}
# Send body as JSON to the fixed Connector endpoint after authorization.
# Keep this requestId with the request and reuse it on transport retries.
# Do not print body or contentBase64 to the terminal or conversation.
```

Set `convertTo="none"` to preserve the original Excel file. Optionally pass `parentId` for the intended folder. The upload response identifies the created file and whether conversion occurred; inspect the resulting spreadsheet because Excel-only features may not convert exactly. For replacement of a regular file's contents, use `update-file-content` with `fileId`, `mimeType`, and `contentBase64`; this requires the additional full Drive scope. These actions preserve Google sharing and resource permissions.

## Hosting

Deploy the included Docker image behind HTTPS, preserve `/app/data`, set `APP_ORIGIN` to the public origin, and retain `ENCRYPTION_KEY`. Register matching OAuth callback URLs for each platform. The optional Render blueprint needs `APP_ORIGIN`, a 64-hex-character encryption key generated by setup, and your provider app settings supplied securely. The blueprint uses paid persistent hosting and does not run automatically.

Do not publish `.env`, SQLite files, platform credentials or the connector API key to GitHub. Rotation of `PIPELINE_API_KEY` requires updating your bot's connector credential. Rotating `ENCRYPTION_KEY` requires a credential migration or reconnecting accounts; it cannot decrypt data written with the old key.
