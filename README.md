# Connector

A self-hosted delivery connector for Grok and other MCP clients. Create and manage your content in your bot; Connector authenticates your accounts and executes supported official platform API actions.

The small dashboard is for account connections, connector setup, and job history. The MCP tools handle publishing, scheduling, supported comment/DM replies, analytics, campaign operations, conversion uploads, and spend reports. Each platform exposes a different subset; discover its exact actions with `list_actions`. Unsupported API features are not simulated.

## Connect it in Grok

1. Run Connector on a persistent host with a public HTTPS address. Set `APP_ORIGIN` to that address and configure the platform developer apps described below.
2. Open the dashboard, sign in, and connect the platforms your bot will use.
3. In Grok's custom connector settings, add `https://YOUR_HOST/mcp` as a **Streamable HTTP MCP** endpoint.
4. Enter the generated `PIPELINE_API_KEY` as the connector credential. The server accepts `Authorization: Bearer YOUR_KEY` or `X-API-Key: YOUR_KEY`. Never put the key in the URL.
5. Let the client discover the tools, then ask it to list your connections. Ask it to inspect a platform's actions before publishing.

This uses the custom-connector workflow: one endpoint, tool discovery, and API-key authentication. Grok's actual client must support this transport/authentication combination; compatibility in your account still needs a live connection test. The software has not been hosted or connected to your Grok account automatically. A cloud-hosted bot cannot reach `localhost` on your computer.

Direct MCP usage does **not** require an additional xAI developer key in Connector. OpenAI, Anthropic and xAI API key connections are optional and distinct from consumer chat subscriptions. An optional standalone Grok API bot is included below.

See [the connector protocol and examples](docs/pipeline.md) for REST usage, request confirmation, and scheduling behavior.

## Run locally

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
| AI APIs | OpenAI (ChatGPT API), Anthropic (Claude API), xAI (Grok API) | Add a developer API key in the dashboard. Consumer subscriptions do not include API access automatically. |
| Meta | Facebook Pages, Instagram professional accounts, Threads, Meta Business Manager | [Meta setup](docs/providers-meta.md) |
| Google | YouTube, Google Ads, Google Analytics, Google Search Console | [Google setup](docs/providers-google.md) |
| Social and websites | X, TikTok, LinkedIn, Reddit, Pinterest, WordPress.com | [Social setup](docs/providers-social.md) |
| Advertising | LinkedIn Campaign Manager, Microsoft Advertising, TikTok Business Manager, X Ads, Reddit Ads | [Advertising setup](docs/providers-ads.md) |
| Communications | Discord profile and server memberships | [Discord setup](docs/providers-discord.md) |

Each platform has its own developer app, permissions, and approval process. The dashboard lists missing server settings and the exact OAuth callback. Add developer app IDs/secrets to `.env` and restart Connector; then use **Connect** to complete the official authorization flow. API keys and manual developer access tokens are entered in the authenticated dashboard and stored encrypted. Reconnect existing grants after enabling new action permissions.

Register each callback URL exactly as documented: `APP_ORIGIN/api/oauth/PROVIDER_ID/callback`. Localhost works only for providers that allow it. For the others, host Connector behind HTTPS, set `APP_ORIGIN` to that public origin, and register the matching HTTPS callback. Do not change the callback hostname partway through authorization.

Review each provider's consent screen: publishing and advertising need broader scopes than account verification. Account discovery and reports are deliberately bounded. Some responses are previews or asynchronous submissions, and tool results state that distinction. Provider approvals, pricing, quotas, media ownership rules, messaging windows, and account eligibility still apply.

YouTube has no general DM API. TikTok and LinkedIn messaging are not exposed where the standard official APIs do not permit them. Instagram requires a professional account linked to a Page for this implementation. Discord channel actions use a bot token with proper channel permissions, never a user self-bot. WordPress uses WordPress.com or Jetpack-connected sites. Campaign creation generally creates a **paused campaign shell**: ad groups, targeting, assets and ads must be configured before delivery; explicit activation changes the specified campaign's status.

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

This is a single-owner app: one connection per platform, with multiple discovered pages/accounts shown inside that connection. Reconnecting a platform replaces its existing credential only after the new credential is verified successfully.

Provider credentials, queued publication payloads, and saved action results are encrypted with AES-256-GCM before they enter SQLite. Browser sessions use HttpOnly cookies, server-side expiry, and CSRF protection. OAuth state is bound to the initiating session and consumed once. HTTPS deployments use secure cookies. Credentials are never returned in dashboard or tool responses. The pipeline key grants the caller access to connected account actions, so only share it with clients you authorize.

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
