# Google Workspace accounts and AI agent permissions

Connector can keep several Google accounts connected at the same time. A profile defines the explicit list of accounts and apps available to a credential. Select that profile when authorizing an MCP OAuth connection, or use its generated key for HTTPS API access; no Anthropic, OpenAI, or xAI developer key is needed. Adding an account or an app does not remove your existing social, advertising, WordPress, Mailchimp, or Google connections.

For a compatible client, give a profile such as **Grok Bot — business** access to Sheets, Gmail, and Tasks on `business@example.com`, and give **Claude — personal** access to Docs and Drive on `personal@gmail.com`. You can also let one agent use several accounts. Choose a default account or ask the agent to specify an account for each operation.

## One-time Google app setup

Google requires your own OAuth application for this locally hosted connector. Its client ID and secret are shared by all the Google accounts you add; each account still authorizes its own permissions. This is Google's destination-account setup, separate from connecting your existing AI subscription to Connector.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and sign in.
2. Use the project selector at the top to select a project, or click **New project**, enter a name, and click **Create**.
3. Open **APIs & Services → Library**. Enable the APIs for the apps you plan to use: Google Sheets API, Google Docs API, Google Slides API, Gmail API, Google Drive API, Google Meet REST API, Google Chat API, Tasks API, and Admin SDK API for Voice audit reports.
4. Open **Google Auth Platform**. If prompted, click **Get started** and enter the app name, support email, audience, and contact email.
5. Choose an **External** audience when connecting personal Google accounts or accounts outside your organization. In testing mode, add every account you intend to connect under **Audience → Test users**.
6. Open Connector in your browser and open **Google Workspace**. Copy the Google callback URL shown there. If using the public connection address, first open that address and sign in there so Google returns to the same browser session.
7. Back in Google Cloud, open **Google Auth Platform → Clients → Create client**. Choose **Web application**, name it, and paste the callback URL under **Authorized redirect URIs**. Click **Create**.
8. Copy the client ID and client secret into Connector's Google connection settings and save them. These are app credentials; they are not your Google account password.
9. For Google Chat, also complete the Google Chat API configuration in your project. Google Workspace administrators may need to allow the app and requested scopes.

Google may require app verification for sensitive or restricted scopes, particularly Gmail and Drive. External apps left in Google's **Testing** publishing status normally receive refresh tokens that expire after seven days when these scopes are used. Connector cannot extend Google's token lifetime; move to an appropriate production setup and complete Google's requirements for long-term use. Workspace administrators can also restrict access. See [Google OAuth production requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness) and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## Add a Google account

1. In Connector, open **Google Workspace**.
2. Select the apps you want to enable and choose the button to add a Google account.
3. Google's sign-in page opens. Choose the intended account, or choose **Use another account**.
4. Review the requested permissions and approve the apps you selected.
5. Google returns you to Connector. Check the email address on the account card.
6. Repeat these steps for another Google account.

Connector records the permissions Google actually granted. If you deselect a permission on Google's consent page, the affected app appears as needing authorization and cannot be assigned to an agent. To add permissions later, use that account's authorization control and select the additional apps. Existing permissions are included in that request. Selecting a different Google account during reauthorization produces an error and preserves the original connection; use the add-account flow for a new account.

## Update an existing connection for expanded actions

Updating Connector adds tools; it does not silently expand a Google authorization. Existing accounts, agent profiles, and keys remain saved. Sheets formulas, tabs, formatting, and batch updates use the existing `spreadsheets` permission. Docs, Slides, and Tasks also use their existing write scopes.

1. Update Connector using its normal update workflow, then restart it.
2. Open **Google Workspace**. An account with **Additional Google permissions needed** lists the apps whose new actions need a fresh grant.
3. In your existing Google Cloud project, open **Google Auth Platform → Data Access → Add or remove scopes**. Add the scopes shown under Connector's **Change connected apps → View requested Google permissions**, then save. Enable the corresponding APIs under **APIs & Services → Library**. Changing Google's scope list alone does not update a saved account token.
4. In Connector, choose **Change connected apps** for the account, keep its intended apps selected, and select **Continue to Google**. Choose the same account and approve the requested access. Any Google verification or Workspace administrator requirements still apply.
5. In **AI agent access**, confirm that the intended profile permits these apps for this account. No replacement profile key or reset is needed.
6. Ask your agent to refresh `list_workspace_accounts` and `list_workspace_actions` for each app. Resolve any returned `missingPermissions` before using actions that need them. Older actions remain available where their original permissions are still granted.

The expanded grants below supplement the baseline scopes. Names without a full URL use the prefix `https://www.googleapis.com/auth/`. The live **View requested Google permissions** list is authoritative for your installed version.

| App | Additional grants |
| --- | --- |
| Sheets, Docs, Slides, Tasks | None; their existing write scopes cover the expanded tools. |
| Drive | `drive.readonly`, `drive`, `drive.appdata`, `drive.apps.readonly`. Full `drive` covers the existing read/file access but not app-data or installed-app-list permissions. |
| Gmail | `https://mail.google.com/`, `gmail.settings.basic`. These allow broader mailbox changes, including permanent deletion, and supported user settings; they do not enable domain-wide delegation. |
| Meet | `meetings.space.settings`. |
| Chat | `chat.spaces`, `chat.messages`, `chat.memberships`, `chat.delete`, `chat.users.readstate`, `chat.users.spacesettings`, `chat.spaces.pins`, `chat.customemojis`, `chat.users.sections`, `chat.users.availability`. Google may restrict individual scopes or methods by account, rollout, or administrator policy. |

A useful message for Grok Bot:

> Refresh your Connector Workspace accounts and actions. Use the intended Google account and profile. Sheets now supports formulas, tabs, formatting, and batch updates; Drive supports binary uploads and Excel conversion. Read each action's current schema before using it. Report missing Google permissions, and verify the result after any authorized write.

## Sheets formulas, tabs, and formatting

`write-values` preserves the previous `RAW` default so imported strings remain literal. To calculate formulas, choose `valueInputOption="USER_ENTERED"`, or use the dedicated `write-formulas` action. `USER_ENTERED` also parses numbers and dates according to the spreadsheet's locale. Read cells with `valueRenderOption="UNFORMATTED_VALUE"` to verify calculated values, or `FORMULA` to inspect stored formulas.

The Sheets actions can inspect spreadsheet/tab metadata, add and rename tabs, apply cell formatting, and execute official Sheets batch requests for operations such as charts, conditional formatting, validation, dimensions, and frozen rows. Read the current schema for exact fields and supported limits. Use the tab's numeric `sheetId` where requested; it is distinct from the document's `spreadsheetId`.

## Download, upload, and export Drive files

- `download-file` returns stored files such as logos, images, PDFs, and ZIP archives, up to 20 MiB each. The response contains original bytes as base64, filename, MIME type, byte count, and SHA-256 digest. Google sharing and download restrictions still apply.
- `upload-file` accepts exact binary bytes as `contentBase64`, a filename, and MIME type, up to 20 MiB. Set `convertTo="google-sheets"` with an XLSX/XLS MIME type to convert an Excel workbook into a native Google spreadsheet. Inspect the result because Excel-only features may not convert exactly.
- `update-file-content` replaces a regular Drive file's bytes. It does not replace the structure of a native Google document; use its Docs, Sheets, or Slides API instead.
- `export-file` exports supported native Google documents, spreadsheets, and presentations, up to 10 MiB. Choose a supported MIME type from the action schema. CSV/TSV exports include only a spreadsheet's first sheet; image exports include only a presentation's first slide. Folders are not downloadable archives.

Have the agent read/encode uploads and decode downloads in a script on its computer, without pasting base64 into chat. Check size and SHA-256 on returned downloads/exports and use an explicit safe local filename. Uploads and content replacements require write confirmation and a unique request ID; downloads and exports do not.

Existing `drive.readonly` or full `drive` grants allow stored-file downloads. Expanded Drive operations request full `drive` access; app-data and app-list operations have their own scopes shown in the consent list. Old metadata and app-created-file operations remain available without silently broadening their grant. See the [HTTPS file examples](pipeline.md#download-a-drive-file).

## Give an AI agent access

1. In **Google Workspace**, create an AI agent profile and name it, such as **Grok Bot — work**.
2. Select the Google accounts this agent may use. Check their exact email addresses.
3. For each selected account, choose the apps the agent may use.
4. Optionally choose a default Google account. With no default, the agent must specify an account ID when calling an app action.
5. Save the profile. The profile's generated API key is available for advanced key-based clients; you do not need to copy or enter it for OAuth.
6. Open **AI connections** and follow the [AI app setup guide](ai-connections.md) to add the public MCP URL in a compatible MCP client with OAuth authentication. For Grok Bot's HTTPS API route, follow the separate instructions below instead of these OAuth steps.
7. On Connector's **Authorize an AI connection** page, select this profile under **Google Workspace agent profile**. Review the account emails and app permissions. Check **Standard platform tools** too if this AI should also use your social, advertising, communications, website, and Obsidian connections. Leave it unchecked for a Google-only agent. Click **Approve selected access**.
8. Return to the AI app, enable Connector for the conversation, and ask the agent to list its permitted Workspace accounts without making changes. Then inspect an app's available actions. Writes require explicit confirmation through the tool's confirmation argument.
9. Create a separate profile and authorize each additional AI connection when it should have different permissions. Selecting the same profile gives those AI connections the same Google account/app permissions.

An OAuth connection can expose both standard platform tools and the selected Workspace profile through one connector entry. With **No Google Workspace access** selected, it has no access to these Workspace tools, even if standard platform access was approved. The separate standard YouTube, Ads, Analytics, and Search Console connectors remain standard platform connections.

Edit a profile to change its permitted apps or accounts without signing those Google accounts in again. Removing a permission takes effect on the next request. Delete a profile to remove access through that profile while retaining the connected Google accounts. OAuth grants that selected the deleted profile also stop working, including any standard platform access within those grants; approve a new connection if the AI should retain standard access. Disconnecting one Google account removes only that account and its agent bindings. To revoke one AI's entire OAuth grant, use **AI connections → Approved AI connections**; this also removes its standard platform access if that was included, without affecting other AI grants.

### Advanced: existing API-key clients

The existing general connector key continues to work for standard platform connections. A Workspace profile key grants only the Workspace permissions in that profile. For a client supporting only key authentication, copy its profile key when created or rotated, add the public `/mcp` URL, and supply the key as a Bearer token or in the client's API-key field. This key is generated by Connector; it is not an AI developer key. Key-only clients need separate general and Workspace connector entries to use both groups.

Rotate a profile key if you need a replacement; the previous key stops working immediately. Rotating a profile key does not revoke separately approved OAuth grants. Revoke those from **AI connections** if needed. Keep different keys/profiles for agents that need different access.

### Grok Bot and other clients using the HTTPS API

1. Create a profile and choose only the Google accounts and apps it should permit. Name it clearly, such as **Business Google access**.
2. Copy the profile's key when it is created. If you no longer have it, rotate it and copy the replacement; the previous key stops working, so update existing clients that use it.
3. Open **AI connections → Grok Bot** and use **Copy instructions for Grok Bot**. Send the message to your Bot and tell it you are providing a Workspace profile key.
4. Enter that key only through a supported masked secure secret request, or use **Take over** to enter it into a masked prompt prepared by the Bot. Do not paste it into chat, a URL, a shared document, or a skill. See the [complete Grok Bot steps](ai-connections.md#grok-bot).
5. Have the Bot request `GET /api/v1/workspace/accounts` with that key in an `Authorization: Bearer ...` or `X-API-Key` header. Check the exact accounts and permitted apps returned before asking for a write. These REST calls do not appear in the OAuth **Approved AI connections** list.
6. To use standard platforms as well, provide the separate general Connector key through the same secure flow. Use each key only for its corresponding endpoints; a profile key does not expose standard platforms, and the general key does not expose Workspace.

**Grok Bot's Bots share one computer, including files, browser logins, and command-line credentials; plugins are account-wide too.** Connector checks permissions against the credential on each request, but it cannot prevent one Bot from using another credential available on that shared computer. Separate profile names do not give separate Bots an access boundary. Share a key there only if every Bot on that Grok Bot account may have that key's access. See [Grok Bot's shared-computer documentation](https://docs.x.ai/grok-bot/computer-and-apps).

## What the apps can do

| App | Supported operations and limits |
| --- | --- |
| Sheets | Create and inspect spreadsheets; read/write cells and formulas; add/rename tabs; format cells; run batch updates and official API requests. |
| Docs | Read/create documents and append text; official API requests for document edits, formatting, tables, and supported document features. |
| Slides | Read/create presentations and add text slides; official API requests for supported slide, shape, text, image, layout, and presentation operations. |
| Gmail | Search/read messages; draft/send messages; official user API requests for supported mailbox, label, attachment, message, and settings operations. Some settings require domain-wide delegation, which this user OAuth connection does not provide. |
| Drive | Search metadata; download/upload/replace regular files up to 20 MiB; convert Excel to Sheets; export native documents up to 10 MiB; official JSON API requests for files, folders, permissions, shared drives, and other supported resources. |
| Maps | Search public places and read place details using a separately configured Google Cloud project key. Personal saved places and Timeline are unavailable. |
| Meet | Create meeting links; read spaces and conferences; official user API requests for supported meeting settings, conference participants, recordings, and transcripts. Availability depends on the account and Google subscription. |
| Voice | Read Google Voice audit events as an authorized Workspace administrator. Personal calls, SMS, and voicemail are unavailable through the official API. |
| Chat | List spaces/messages and send messages as the selected user; official user API requests for supported spaces, membership, messages, and related features. Requires an eligible account and configured Chat API; app-only/admin methods are not unlocked by user consent. |
| Tasks | List/create/update task lists and tasks, complete tasks, and use official API requests for supported move/delete/clear operations. Due dates have no time of day. |

Sheets, Docs, Slides, Gmail, Drive, Meet, Chat, and Tasks each expose `read-api` and `write-api` for documented operations under that app's fixed official API origin. These accept relative paths and JSON, not arbitrary external URLs or access to other Google services. All writes still require confirmation and a request ID. Large media uploads/exports use the dedicated Drive actions rather than the JSON API action. See [request examples and boundaries](pipeline.md#expanded-workspace-api-actions).

Google permissions, account access, enabled APIs, quotas, and subscription requirements still apply. "Connected" confirms authorization, not every website feature or administrator capability. APIs that require a service account, domain-wide delegation, app-only authentication, or an administrator role remain subject to those requirements. Voice audit access requires administrator reporting privileges and does not control a personal Voice account. Calendar is not a separate Workspace app in this connector; creating a Meet space does not send Calendar invitations.

## Add a Maps project key

Google Maps Platform uses a billed project rather than access to a person's Maps account. Connector associates a project key with a chosen Google account to make agent permissions and project selection clear.

1. In [Google Cloud Console](https://console.cloud.google.com/), choose the project that should pay for Maps usage.
2. Enable **Places API (New)** and configure billing for that project.
3. Open **APIs & Services → Credentials → Create credentials → API key**.
4. Restrict the key to **Places API (New)**. If your server has a stable outbound IP address, use an appropriate server IP restriction. Browser referrer restrictions do not work for this server-side connection.
5. Copy the key. In Connector, find the intended Google account and save the key in its Maps connection control.
6. Edit the intended agent profile and enable Maps for that account.

A different Google account can have a different Maps project key. Removing a key immediately disables Maps actions for that account's agent profiles; other Google apps remain connected.

## Preserving connections when adding connectors or updating

Google refresh tokens, Maps project keys, and account settings remain in Connector's encrypted local database. Agent keys are stored as hashes. Use the provided update workflow, which preserves the database and encryption key. Do not delete the `data` folder or replace the encryption key when updating: both are needed to retain connections.

New connectors can be added without changing your existing account credentials. You authorize only the new account or newly requested permissions. Google or another provider can still require sign-in again when you revoke consent, change security settings, exceed refresh-token limits, or let a testing-mode token expire.

## Backend details

- Owner-only dashboard routes live under `/api/workspace` and use the normal authenticated browser session and origin checks.
- Google callback: `/api/workspace/google/callback`. Authorization state is encrypted, expires after ten minutes, is bound to one browser session, and is consumed once. Authorization uses PKCE and offline access.
- Account IDs are stable opaque values derived from the verified Google subject, not user-supplied email addresses. Reauthorizing an account cannot replace it with another Google identity.
- Credential rows use `google-workspace:<accountId>`; metadata and agent profiles use encrypted settings. Existing provider rows and scheduled jobs keep their existing identifiers.
- Apps are enabled only when all their required scopes are present in Google's returned grant. A scope reduction during refresh disables access through existing bindings. Additional scopes unlock expanded actions without removing existing app bindings. Account discovery reports per-app `missingPermissions`; an action checks its own required grants and rejects missing permissions before calling Google. Full Drive access also satisfies the narrower existing Drive permissions.
- OAuth AI grants refer to the selected profile; account/app permissions are read again for each call. An OAuth grant does not reveal the profile API key to the AI client.
- Advanced agent API keys contain 32 random bytes and are returned only once. Fresh profile and key checks enforce permission changes, rotation, and revocation on subsequent requests.
- Token refresh is serialized separately for each account. Rotated refresh tokens are saved, and disconnecting an account during refresh cannot recreate its connection.
