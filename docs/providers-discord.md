# Discord

Connector uses Discord's official OAuth2 authorization-code flow to verify your Discord identity and list up to the first 100 servers you belong to. It requests only `identify guilds`. This OAuth connection does not invite a bot, join servers, access messages as your user account, request email access, or change server permissions. The separate optional bot actions described below can read and send messages as your configured bot.

## Setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. In the application's OAuth2 settings, add the exact redirect URL shown in Connector: `APP_ORIGIN/api/oauth/discord/callback`. For the default local origin this is `http://localhost:3000/api/oauth/discord/callback`; for a deployed installation use its HTTPS origin. Save the same exact URL, including path, in Discord.
3. Put the application's client ID in `DISCORD_CLIENT_ID` and client secret in `DISCORD_CLIENT_SECRET` in the server's private `.env` or deployment secret store. Restart Connector after changing server configuration. These credentials stay on the server.
4. Click Connect for Discord, sign into Discord, and authorize profile/server-membership access. No bot token is needed.

Basic `identify` and `guilds` OAuth scopes are documented scopes; they do not require privileged bot intents. Any account/app restrictions imposed by Discord still apply.

## API and token behavior

- Authorization: `https://discord.com/oauth2/authorize`, with response type `code`, scopes `identify guilds`, and a random server-validated OAuth state.
- Token exchange and refresh: form-encoded `POST https://discord.com/api/oauth2/token`. Discord accepts client ID and secret in the form body. The flow follows Discord's documented confidential-client OAuth flow; its documentation does not specify PKCE for this flow.
- Account: `GET https://discord.com/api/v10/users/@me` with bearer authentication.
- Servers: `GET https://discord.com/api/v10/users/@me/guilds?limit=100` with bearer authentication. Discord returns a top-level array. Empty server membership is a valid verified connection.
- The application stores the access token, refresh token, and actual `expires_in` expiry in its encrypted local store. Verification refreshes expiring tokens when needed and saves rotated refresh tokens. An invalid or revoked refresh token requires reconnection.
- The saved public profile contains only the account ID/display name and server IDs/names. Responses such as email, permissions, and icons are not copied into connection metadata.

Official reference sources were inspected from [Discord's OAuth2 documentation source](https://github.com/discord/discord-api-docs/blob/main/developers/topics/oauth2.mdx) and [User resource documentation source](https://github.com/discord/discord-api-docs/blob/main/developers/resources/user.mdx). The latter documents `identify` for `/users/@me`, `guilds` for `/users/@me/guilds`, and a guild-list limit of 1–200. Connector deliberately displays a sample of up to 100.

Tests mock the official HTTP contracts and verify scope/state, token exchange, refresh rotation, profile/resource mapping, empty membership, invalid response handling, and secret-safe errors. No real Discord app credentials or account were available during development, so live OAuth authorization still requires your app setup above.

## Optional bot messaging actions

To use channel message actions, create or use a Discord bot you own in the Developer Portal and set `DISCORD_BOT_TOKEN` in the server's private environment. Keep it separate from the OAuth client secret and never enter a normal Discord user token. This variable is optional for connecting/verifying an account and is required only when executing bot message actions. Restart the app after changing environment configuration.

Install that bot into the intended server through Discord's official bot installation flow. Grant the target channel's **View Channel**, **Send Messages**, and **Read Message History** permissions as needed. Threads/voice channels can require their additional corresponding permissions. Reading message text can require the Message Content privileged intent and Discord approval at applicable bot sizes; fields unavailable to the bot may be empty. Use Discord Developer Mode to copy the channel and message IDs.

- **Publish bot message** posts up to 2,000 characters to a channel and can be scheduled.
- **Read channel messages** returns up to 50 recent messages the bot can access.
- **Reply as bot** replies to an existing message using `message_reference` and is not schedulable. Replies fail if the referenced message is missing.

All three operations use `Authorization: Bot …` with the configured bot credential, never the connected user's OAuth credential. The UI connection identifies your Discord user; the bot actions act as the server-configured bot. A channel ID must refer to a channel available to that bot, including an existing bot DM channel where Discord permits it. The app does not create unsolicited user DM channels, invite itself, or automate a personal account. Automatic mention parsing and replied-user notifications are disabled when sending, so `@everyone` or user mentions in supplied content do not unexpectedly notify people.

Requests use official `GET/POST https://discord.com/api/v10/channels/CHANNEL_ID/messages`. The [Discord Message resource documentation](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx) documents permissions, content limits, reply references, and allowed mentions. Tests verify bot-only credentials, fixed official endpoints, request validation, bounded results, and notification suppression. All writes were mocked during development.
