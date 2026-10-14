# Connector

A self-hosted delivery connector for Claude, ChatGPT, Grok, and other compatible MCP clients. Create and manage your content in your AI app; Connector authenticates your accounts and executes supported official platform API actions.

The dashboard guides you through setup, account connections, and AI-agent access. The MCP tools handle publishing, scheduling, supported comment/DM replies, analytics, campaign operations, conversion uploads, spend reports, and read-only bank data. Each platform exposes a different subset; discover its exact actions with `list_actions`. Unsupported API features are not simulated.

**Google Workspace** has a separate multi-account area: connect several Google accounts, then give each AI agent an explicit set of accounts and apps. **Obsidian** reads and writes Markdown notes in the vault on your PC that Obsidian Sync keeps up to date.

**Use your existing AI subscription.** In **AI connections**, copy Connector's public URL into your AI app's custom connector settings, choose OAuth, and approve access with your Connector password. This route does not require an Anthropic, OpenAI, or xAI developer account or API key. Availability of custom connectors depends on the AI app, your plan, and workspace policies; see the [step-by-step AI connection guide](docs/ai-connections.md).

## Start on your Windows PC — no terminal commands

1. [Download the app ZIP](https://github.com/GiftedElephant1/connector/archive/refs/heads/main.zip), choose **Extract All**, and open the extracted folder. A smaller `Connector-Windows.zip` is also available from successful **Package Windows app** workflow artifacts.
2. Double-click **Start Connector**. Its progress window downloads a verified private runtime, installs dependencies, prepares storage, and opens the dashboard. Once startup finishes, click **Hide to tray** or the window's **X** to leave Connector running in the Windows notification area beside the clock.
3. Choose your workspace password in the welcome screen.
4. Open **Settings**, follow the link to ngrok's **Your Authtoken** page, paste its token, and click **Start public access**. No separate ngrok installation or command is needed. Connector saves the token encrypted and reconnects on later launches until you stop public access.
5. Click **Open public workspace**, sign in with the password you chose, and click **Connect account** on a platform. If application credentials are required, the app presents a guided form, a developer-portal link, and a copyable callback address. Save credentials directly in the interface; changes apply immediately.
6. Open **AI connections**, choose Claude, ChatGPT, or Grok, and follow the card's instructions to add the public connector URL in that AI app. Choose **OAuth** where offered, sign in with your Connector password, and approve standard platform access and/or the Google Workspace profile the agent may use. Start with an account-list request.

The launcher supports Windows 10/11 x64 and ARM64 and needs Internet access for its first installation. It uses port 3000. After startup, closing its window with **X** hides it and leaves Connector running, as does closing the browser. Right-click the Connector icon beside the clock (check the **Show hidden icons** arrow if needed) to open the dashboard, view the status log, or **Stop Connector**. Your PC must stay on, awake, signed in, and online for scheduled posts and remote access. See [Windows use and troubleshooting](docs/windows.md).

To start Connector automatically when you sign in to Windows, enable **Start with Windows** in its window or tray menu. This is optional and off by default. Automatic starts run in the background without opening the browser.

**Entered the wrong connection details?** Choose **Disable and reset** on the connector, review any shared accounts it affects, confirm, and select **Set up again**. This clears saved account access and developer-app details, cancels pending platform jobs, and prevents an old sign-in from restoring the connection. Google Workspace and AI connections have corresponding reset controls. See [resetting connectors](docs/reset-connectors.md).

The Connect buttons use official authentication. Social, advertising, Google, and other destination platforms may still require their own developer applications, permissions, and approvals; this self-hosted app does not include centrally approved registrations for those services. This is separate from connecting your AI app, which does not need an AI developer key. Plaid opens its own bank picker after application setup; WhatsApp uses its Business Cloud API credentials.

For TikTok's developer review, open **Settings → TikTok app review**. Review the public operator name and contact email on the **Terms of Service** and **Privacy Policy**, then copy the generated HTTPS URLs, download the app icon, and copy the product/scope explanation. The [TikTok review guide](docs/tiktok-review.md) walks through the real sandbox demo recording and submission fields. The public pages are available without dashboard sign-in while Connector and its public connection remain running. TikTok decides whether this self-hosted, single-owner app is eligible for its products; preparing these materials does not guarantee approval.

The **TikTok** and **X** connection setup screens include complete developer-account and application-registration instructions, with the exact URLs and permissions to use. TikTok's setup also accepts its website-verification text file through a file picker. Follow the [TikTok account and review guide](docs/tiktok-review.md) or [X developer-account guide](docs/providers-x.md) for the full steps; destination-platform registrations remain separate from your AI subscription.

## Add future connectors without reconnecting existing accounts

Open **Settings → Updates and new connectors** to download an update or prepare a connector request to copy into your conversation with the developer. A new platform needs an official API integration before it becomes available, followed by its own account authorization.

On Windows, extract the new download, right-click Connector's icon beside the clock and choose **Stop Connector**, then double-click **Update Connector** in the **new** folder. Select your **existing** Connector folder in the wizard. It prepares the new app before replacing application files and keeps your saved accounts, workspace settings, scheduled jobs, and connector API key in the original installation. Start the app from that original folder after updating. See the [complete update steps](docs/windows.md#update-without-reconnecting-your-accounts).

An app update does not require authorizing every account again. A platform may still require authorization if it revokes access, a token can no longer refresh, or an added action needs new permissions. Keep the same public address for Grok and other clients; if your tunnel address changes, update their connector URL.

## Connect Claude, ChatGPT, or Grok

Connector provides a public HTTPS MCP endpoint with OAuth sign-in and permission approval. Your AI app runs the model using your subscription; Connector supplies the tools. You do not paste your AI account password or subscription token into Connector.

1. Start Connector and turn on public access in **Settings**. Keep your PC awake and online; Connector can run in the notification area with its window and browser closed.
2. Connect the destination accounts your AI should use. For Google Workspace, create an agent profile with the allowed accounts and apps.
3. Open **AI connections**. Copy the displayed `/mcp` URL and open the relevant AI app's settings from its card.
4. Add a custom connector/app using that URL and **OAuth** authentication. The client handles registration automatically; no Anthropic, OpenAI, or xAI developer registration is needed.
5. On Connector's authorization page, enter your Connector password, review the requesting client, and choose whether to allow standard platform tools, a Google Workspace profile, or both.
6. Return to the AI app, enable Connector for the conversation where required, and ask: **“Use Connector to list the accounts you can access. Do not change anything.”**

Claude and ChatGPT publish custom MCP setup instructions. Grok's consumer custom-connector availability could not be independently verified; use its card if your account offers the custom connector setting. An absent setting cannot be enabled by this server. For a Grok interface that accepts only an API key, the advanced option uses a **Connector-generated key**, not an xAI API key.

Follow the [complete click-by-click guide](docs/ai-connections.md), including authentication choices and connection checks. The [protocol guide](docs/pipeline.md) covers advanced key authentication, REST, confirmation, and scheduling. The optional standalone Grok API bot below is a separate, billed developer-API feature.

## Developer installation

Requires **Node.js 24** and npm. No external database is needed.

```sh
npm ci
npm run setup
npm run build
npm start
```

Open `http://localhost:3000`. Sign in using `APP_PASSWORD` in the generated private `.env` file. You can replace that value with a password of at least 12 characters before starting. `npm run setup` generates a unique password and encryption key, preserves existing nonempty settings, and does not print secrets.

For code changes, run `npm run build` to rebuild the interface and `npm run dev` to restart the server automatically when server files change. The server serves the built interface from `dist/`. Keep one instance running for scheduled jobs; start with a test account and private or paused destinations when testing your configuration.

## Platforms

| Group | Connections | Setup instructions |
| --- | --- | --- |
| AI apps | Claude, ChatGPT, and compatible Grok/custom MCP clients | [Use your subscription through AI connections](docs/ai-connections.md); no AI developer key required. |
| Optional developer AI APIs | OpenAI API, Anthropic API, xAI API | Advanced integrations only. Developer API accounts and billing are separate from the AI app connection above. |
| Meta | Facebook Pages, Instagram professional accounts, Threads, Meta Business Manager | [Meta setup](docs/providers-meta.md) |
| Google | YouTube, Google Ads, Google Analytics, Google Search Console | [Google setup](docs/providers-google.md) |
| Social and websites | X, TikTok, LinkedIn, Reddit, Pinterest, WordPress.com | [Social setup](docs/providers-social.md) |
| WordPress on another host | Create, read, and edit blog posts and pages through WordPress's own REST API | [WordPress setup](docs/providers-wordpress.md) |
| Advertising | LinkedIn Campaign Manager, Microsoft Advertising, TikTok Business Manager, X Ads, Reddit Ads | [Advertising setup](docs/providers-ads.md) |
| Communications | Discord profile/server memberships and bot actions; WhatsApp Business Cloud API | [Discord setup](docs/providers-discord.md), [WhatsApp setup](docs/providers-whatsapp.md) |
| Email marketing | Mailchimp account, audiences, draft campaigns, campaign content, sending, and reports | [Mailchimp setup](docs/providers-mailchimp.md) |
| Finance | Plaid accounts, balances, and transactions, read-only | [Plaid setup](docs/providers-plaid.md) |
| Google Workspace | Sheets, Docs, Slides, Gmail, Drive, Meet, Chat, Tasks, Maps place search, and Voice administrator reports; multiple accounts with separate agent permissions | [Workspace setup](docs/providers-workspace.md) |
| Notes | Read, create, and edit notes in the Obsidian vault on your PC, including notes synced by Obsidian Sync | [Obsidian setup](docs/providers-obsidian.md) |

Destination platforms set their own application, permission, and approval requirements. Click **Connect account** to enter any required credentials, copy the callback address when shown, and continue to official authorization. Change saved details under **Settings → Platform application settings**. These settings are encrypted in SQLite and override matching environment settings without a restart. Existing `.env` configurations remain supported for administrators. API keys and manual developer access tokens are entered in the authenticated dashboard and stored encrypted. Reconnect existing grants after enabling new action permissions.

Plaid defaults to **Sandbox**, which uses test bank data. Real bank accounts need approved Plaid Production access in a supported country; one institution can be connected at a time. Its official Link window handles bank authentication, and Connector never accepts bank passwords. Disconnecting Plaid revokes the Item before removing the local token. Bank data becomes available to assistants whose OAuth access includes Plaid, or that hold the general connector key. No payment or transfer actions are implemented.

WhatsApp requires a business phone number and Meta Cloud API token. It supports phone/profile reads, approved template messages, and replies by a known message ID inside Meta's service window. This version does not receive incoming WhatsApp webhooks or expose personal WhatsApp login. API acceptance does not establish message delivery.

Register each callback URL exactly as documented: `APP_ORIGIN/api/oauth/PROVIDER_ID/callback`. Localhost works only for providers that allow it. For the others, host Connector behind HTTPS, set `APP_ORIGIN` to that public origin, and register the matching HTTPS callback. Do not change the callback hostname partway through authorization.

Review each provider's consent screen: publishing and advertising need broader scopes than account verification. Account discovery and reports are deliberately bounded. Some responses are previews or asynchronous submissions, and tool results state that distinction. Provider approvals, pricing, quotas, media ownership rules, messaging windows, and account eligibility still apply.

YouTube has no general DM API. TikTok and LinkedIn messaging are not exposed where the standard official APIs do not permit them. Instagram requires a professional account linked to a Page for this implementation. Discord channel actions use a bot token with proper channel permissions, never a user self-bot. WordPress has separate connections for WordPress.com/Jetpack sites and sites on another host. Campaign creation generally creates a **paused campaign shell**: ad groups, targeting, assets and ads must be configured before delivery; explicit activation changes the specified campaign's status.

## Configuration and storage

| Variable | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact browser origin, e.g. `http://localhost:3000` locally or `https://connector.example.com`. Remote origins require HTTPS. |
| `APP_PASSWORD` | Password for the single-owner dashboard, at least 12 characters. |
| `ENCRYPTION_KEY` | 32 random bytes encoded as 64 hexadecimal characters. Generated by setup. |
| `PIPELINE_API_KEY` | Machine bearer/API-key credential for MCP and REST. Generated by setup; keep it private. |
| `HOST` | Bind address; defaults to `127.0.0.1`. Use `0.0.0.0` inside a container or behind a reverse proxy. |
| `PORT` | Server port; defaults to `3000`. |
| `DATA_DIR` | SQLite directory; defaults to `./data`. |

This is a single-owner app: one connection per standard platform, with multiple discovered pages/accounts shown inside that connection, plus separate multi-account Google Workspace connections. Reconnecting a platform replaces its existing credential only after the new credential is verified successfully.

Provider credentials, dashboard settings, queued publication payloads, and saved action results are encrypted with AES-256-GCM before they enter SQLite. A dashboard-chosen password is stored as a salted scrypt hash inside encrypted settings. Browser sessions use HttpOnly cookies, server-side expiry, and CSRF protection. OAuth state is bound to the initiating session and consumed once. Public HTTPS sessions use secure cookies; the explicitly configured local desktop dashboard keeps its own session. Saved provider credentials are never returned in dashboard or tool responses.

OAuth access for AI clients is limited to standard platform tools and/or the Google Workspace profile approved by the owner. Review and revoke individual grants in **AI connections** without disconnecting the underlying accounts. Advanced key authentication remains supported: the general connector key grants access to standard platforms, including read-only bank data and the local Obsidian vault; Google Workspace profile keys are restricted to their assigned Google accounts and apps. Never share the general key when a narrower OAuth grant is sufficient.

The desktop launcher uses a random, single-use, ten-minute local sign-in capability, removed from the browser address before normal use. It is not a public registration endpoint. Start and complete account authorization on the public dashboard after enabling HTTPS; local and public hostnames have separate browser sessions.

Back up `.env` and `data/` together and protect both. Losing `ENCRYPTION_KEY` makes saved credentials unreadable. Changing the key is not a migration: disconnect and reconnect accounts if you replace it. The database includes account names and resource metadata. `.env`, SQLite data, logs, build output, and dependencies are excluded from Git.

**Disconnect** removes the local credential. It does not revoke the platform-side grant; revoke that grant in the provider's settings when needed. Pending jobs for a disconnected account fail when due; cancel them in Schedule if they are no longer wanted. Verification checks account API access, not permission for every possible action, available funds, or platform approval. Action requests receive the platform's actual authorization checks.

## Deployment

Run one instance with a persistent data directory. Terminate HTTPS at a reverse proxy and forward traffic to Connector. Keep the service private to its owner, set a strong password, and preserve the encryption key across restarts. The app does not trust forwarded client-IP headers, so the built-in rate limit is shared across clients behind the same proxy.

An optional Docker setup is included (Docker itself was not available in the development environment):

```sh
npm ci
npm run setup
docker compose up --build -d
```

The Compose configuration binds only to loopback on the host and retains SQLite in a named volume. Configure an HTTPS reverse proxy and `APP_ORIGIN` for remote OAuth callbacks and the Grok MCP endpoint. A [Render blueprint](render.yaml) is also provided for review; it uses a paid persistent service/disk and does not deploy or incur charges until you create the service.

## Optional standalone Grok API bot

If you prefer a separate API bot, connect an **xAI API key** in the dashboard, start the server, and run:

```sh
npm run grok
```

This optional client uses separately billed xAI API calls. `XAI_MODEL` selects your available model (default `grok-4`). It discovers connection tools, drafts/manages content in chat, and asks for local approval before writes. `/new` clears the conversation; `/exit` exits. `npm run grok -- --message "List my connections"` runs a single instruction. `--approve-writes` explicitly enables unattended writes for that process; use it only with a trusted caller and intended account permissions. Direct Grok MCP use does not run this client.

## Validation

```sh
npm run typecheck
npm test
npm run build
```

Tests use mocked API responses to exercise provider request contracts, authentication, encryption, OAuth state, token refresh, idempotency, scheduler recovery, REST and MCP tools, and failure handling. Live account verification and writes require your credentials and platform approvals; mocked tests do not establish that access. GitHub Actions runs core checks without credentials. Browser checks require Chromium (`npx playwright install chromium`, then `npm run test:browser`); use `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to select an already-installed Chromium.

`GET /api/health` returns a basic process readiness response. The dashboard requires authentication. `docs/` contains per-provider scope, endpoint, and setup details.
