# Connector read and write capabilities

Connector exposes the supported operations below to your authorized AI connections. **Write support** means the app implements those specific changes through the platform's official API. It does not mean every feature in that platform's website is available, or that the connected account has already received every required permission. Use the action panel or ask your agent to call `list_actions` or `list_workspace_actions` for exact fields and limits.

Account verification reads your account details without publishing anything. A successful connection check alone does not prove that your account role, app approval, or subscription permits a write. Write operations require authorization for the intended content and target; Connector also requires confirmation and a unique request ID to prevent accidental repeat submissions.

## Platforms

| Connector | Supported writes | Access notes |
| --- | --- | --- |
| X (Twitter) | Publish posts, reply publicly, send direct messages. | Requires the requested post/DM write permissions and eligible X API access. |
| TikTok | Submit a video through Direct Post. | Requires `video.publish` approval and creator-selected publishing settings; processing and visibility restrictions apply. General comments and DMs are not provided by this integration. |
| LinkedIn | Publish member posts and write member comments/replies. With company access enabled, list managed company Pages, read their recent posts, and publish company text posts. | Member publishing requires `w_member_social`; member Social Actions approval still applies. Company access requires approved `rw_organization_admin`, `r_organization_social`, `w_organization_social`, a fresh grant, and an eligible Page role. Company actions require an explicit organization URN. |
| Reddit | Publish posts, reply to posts/comments, send/reply to legacy private messages. | Requires approved app access and `submit`/`privatemessages`. Reddit Chat is separate. |
| Pinterest | Publish Pins. | Requires `pins:write`, board access, and any required app approval. |
| WordPress.com | Publish posts and reply to comments. | Acts on the authorized site with the connected user's permissions. |
| Facebook | Publish Page posts and reply to comments/messages. | Requires Page permissions and any applicable Meta review; personal-profile publishing is not supported. |
| Instagram | Publish supported media containers and reply to comments/messages. | Requires an eligible professional account, a linked Facebook Page, and the relevant Meta permissions. |
| Threads | Publish posts and replies. | Requires content publishing and reply permissions. |
| YouTube | Upload videos and reply to comments. | Requires upload/comment permissions. Unaudited API projects can be limited to private videos. YouTube has no general DM API. |
| Meta Business Manager | Create campaigns, traffic ad sets, post creatives and ads; change status; upload conversions. | Requires approved advertising permissions and account roles. Creating a campaign does not guarantee ad delivery. |
| Google Ads | Create a paused Search campaign and budget; enable/pause campaigns; upload click conversions. | Requires `adwords`, a developer token, and appropriate account access. Ad groups, keywords and creatives still need to be configured in Google Ads. |
| LinkedIn Campaign Manager | Create campaigns, change campaign status, send conversions. | Requires `rw_ads`; conversions additionally require approved `rw_conversions` access and its setup option. |
| Microsoft Advertising | Create campaigns, change campaign status, send conversions. | Requires advertising management permission, a developer token, and account access. |
| TikTok Business Manager | Create campaigns, change campaign status, send conversions. | Requires approved Business API access and suitable advertiser permissions. |
| X Business / Ads | Create campaigns, change campaign status, send conversions. | Requires approved Ads API access and the configured advertising/conversion credentials. |
| Reddit Ads | Create campaigns, change campaign status, send conversions. | Requires `adsedit`; conversions use a separate Events Manager token. |
| Google Analytics | Configure GA4 key events. | Requires `analytics.edit` and a suitable property role. This changes measurement configuration; it does not overwrite historical traffic or fabricate events. |
| Google Search Console | Submit and remove sitemap submissions. | Requires `webmasters` and suitable property access. This does not change search rankings, edit performance reports, or guarantee indexing. |
| Discord | Publish channel messages and reply as your configured bot. | The bot needs channel permissions and its separate bot token. Connecting a personal Discord identity does not authorize user-account messaging automation. |
| WhatsApp Business | Send messages, replies, and approved templates. | Requires Cloud API messaging permissions, an eligible business phone number, and compliance with messaging windows/template rules. Personal WhatsApp is not supported. |
| WordPress (your hosting provider) | Create and update blog posts and pages, including publishing. | The Application Password inherits the chosen WordPress user's role. Choose a role that can edit the intended content. |
| Mailchimp | Create email campaign drafts, replace draft content, send campaigns. | Requires a Marketing API key with the necessary account role and an eligible audience/sender. |
| Obsidian | Create, append to, and update Markdown notes. | Writes to the selected local vault; Obsidian Sync handles cloud synchronization. The PC's filesystem must allow writes. |
| Plaid | **Bank data is read-only.** | The connected Transactions product reads accounts, balances, and transactions. It cannot edit bank records or move money. |

All advertising connectors can also read supported campaign/spend reports, and supported conversion uploads are separate actions. Campaign builders provide a subset of each advertising API, not every creative, targeting, budget, or campaign type. A returned creation ID does not mean a complete ad is serving.

## Google Workspace

Each Google account authorizes its selected apps independently. Each AI profile receives only the accounts and apps assigned to it. The writable apps below already request write permissions; a scope name containing `readonly` for an additional reporting or lookup operation does not make the entire connector read-only.

| App | Supported writes | Access notes |
| --- | --- | --- |
| Sheets | Create spreadsheets and overwrite cell ranges. | Uses `spreadsheets`; entered values are literal, so formulas are not evaluated. |
| Docs | Create documents and append text. | Uses `documents`; existing document replacement/formatting is not implemented. |
| Slides | Create presentations and add text slides. | Uses `presentations`; arbitrary layout/media editing is not implemented. |
| Gmail | Create drafts and send plain-text email. | Uses `gmail.compose`, alongside `gmail.readonly` for reading messages. |
| Drive | Create folders and upload text files. | Writes use `drive.file`. Metadata lookup remains available to older connections; approve the additional `drive.readonly` scope to download existing stored files up to 20 MiB. Downloads return base64 bytes and a SHA-256 digest; native Google document export is not supported. |
| Meet | Create meeting spaces and links. | Uses `meetings.space.created`; this does not create Calendar invitations. Account eligibility applies. |
| Chat | Send text messages as the selected user. | Uses `chat.messages.create`, alongside space/message lookup scopes. Requires Chat API configuration and account access. |
| Tasks | Create/update tasks and mark them complete. | Uses `tasks`; due dates have no time of day. |
| Maps | **Places data is read-only.** | Searches public places and reads details using a billing project key. Places API does not write personal saved places, Timeline, or public reviews. |
| Voice | **Audit reports are read-only.** | Reads Voice activity through the administrator Reports API. It does not provide personal calls, SMS, voicemail management, or a messaging write scope. |

Maps business listing management would require a separate Google Business Profile integration and approval. Plaid money movement would require separate payment/Transfer product access and implementation. Those are different products from the connected Places and bank-data APIs; they are not enabled by granting a broader permission here. No unsupported write behavior is simulated.

## AI connections

Compatible MCP clients, including supported Claude and ChatGPT configurations, call Connector's authorized tools to perform these reads and writes. Grok Bot can use the equivalent authenticated HTTPS API from its cloud computer. There is no extra destination-side read-only switch on an AI grant. Standard platform tools must be included in its grant, and Workspace writes must use an assigned Google account/app profile. Any confirmation controls in the AI client's interface still apply. For Grok Bot, follow the [copied-message setup](ai-connections.md#grok-bot), supply the appropriate Connector key through its secure secret flow, and verify an actual authenticated read request before asking for writes. Its Bots share credentials on one cloud computer: Connector permissions apply per key and do not isolate Bots on that account.

The optional Anthropic/OpenAI/xAI developer-key cards only verify API model access; they are not write destinations for the consumer chat accounts. You do not need these developer keys to use supported subscription clients through Connector's MCP connection.

## Upgrade an existing read-only authorization

An application update cannot silently expand a permission already granted by Google or another platform. Your existing connections remain saved when you update.

For an existing Google Analytics or Search Console connection:

1. Update Connector, then open its **Connections** page.
2. In your Google Cloud project's **Google Auth Platform → Data Access**, add `https://www.googleapis.com/auth/analytics.edit` for Analytics, or `https://www.googleapis.com/auth/webmasters` for Search Console. Analytics retains `analytics.readonly` for reports.
3. Open that connector's **View connection** panel, click **Update permissions**, and select the intended Google account.
4. Approve the requested read and write access. The Google account must also have the necessary role on the property.
5. Open the connector's actions, or ask your agent to list its actions, and choose the specific operation you intend to perform.

Updating permissions does not require resetting your shared Google client ID/secret or reconnecting your other Google services. **Disable and reset** is for clearing a mistaken setup; it is unnecessary for approving an added permission. Google's OAuth publishing, verification, and organization policies can still restrict the requested access. See [Google setup](providers-google.md) and [Workspace setup](providers-workspace.md).

Official references for the new writes and read-only boundaries: [GA4 key events](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties.keyEvents), [Search Console sitemaps](https://developers.google.com/webmaster-tools/v1/sitemaps), [Plaid Transactions](https://plaid.com/docs/api/products/transactions/), [Maps Places](https://developers.google.com/maps/documentation/places/web-service/overview), and [Google Voice activity reports](https://developers.google.com/workspace/admin/reports/v1/appendix/activity/voice).
