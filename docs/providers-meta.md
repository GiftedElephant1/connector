# Meta and AI connection adapters

Connection verification reads API access and a bounded sample of resources. The action workbench additionally supports the publishing, messaging, analytics, and advertising operations documented below. Writes run only when submitted by the user or when an explicitly scheduled publication becomes due. List results include at most the first 100 resources for each API collection; Meta Business Manager can show up to 100 businesses and 100 ad accounts. Instagram verification fails with a useful explanation when no linked professional account is found.

## AI API accounts

OpenAI, Anthropic, and xAI require API keys created in their respective developer consoles. ChatGPT, Claude, and Grok consumer subscriptions do not themselves provide these API credentials. Verification calls each provider's model-list endpoint and does not generate billable text. A successful model list confirms API access, not a consumer account identity or ability to pay for generation.

- OpenAI: `GET https://api.openai.com/v1/models`, bearer authentication.
- Anthropic: `GET https://api.anthropic.com/v1/models?limit=100`, `x-api-key` and `anthropic-version: 2023-06-01`.
- xAI: `GET https://api.x.ai/v1/models`, bearer authentication.

Endpoint/authentication evidence: [OpenAI model SDK](https://github.com/openai/openai-node/blob/master/src/resources/models.ts), [OpenAI client defaults](https://github.com/openai/openai-node/blob/master/src/client.ts), [Anthropic model SDK](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts), [Anthropic client defaults](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts), and [xAI SDK client](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/client.py). The xAI SDK confirms host and bearer authentication, while the REST model endpoint is described in the [xAI REST reference](https://docs.x.ai/developers/rest-api-reference/inference/models). Direct access to provider documentation was blocked by this build environment's network proxy; accessible official GitHub sources were inspected. No live account credentials were supplied, so authenticated integration remains to be tested by the account owner.

## Facebook, Instagram, and Meta Business Manager

Create a Meta developer app and set `META_APP_ID` and `META_APP_SECRET` in the server environment. Add the relevant Facebook Login/Instagram/Marketing API products and register each exact callback URL displayed by Connector. `META_API_VERSION` defaults to `v26.0`, matching the [official Meta Node SDK API version](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/api.js) inspected during development. The version is configurable for future API upgrades and must match `vN.N`.

| Provider | Permissions requested | Verification |
| --- | --- | --- |
| Facebook | `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_posts`, `pages_manage_engagement`, `pages_messaging`, `read_insights` | `/me` and `/me/accounts` names/IDs |
| Instagram via Facebook Login | `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `instagram_manage_messages` | `/me/accounts` with each Page's `instagram_business_account` |
| Meta Business Manager | `business_management`, `ads_read`, `ads_management`, `pages_read_engagement`, `pages_manage_ads` | `/me`, `/me/businesses`, `/me/adaccounts` names/IDs |

Instagram must be a business or creator account linked to a Facebook Page. Personal Instagram accounts do not work with this connection path. Facebook profile connections can succeed with an empty Page list. Business Manager can similarly return an empty list when the authorized user has no accessible business/ad accounts.

App users/testers can test eligible permissions while the app is in development. Connecting people outside app roles can require app review, advanced access, and business verification, depending on Meta's product requirements. `business_management` supports business portfolio access. Publishing, messaging, insights, Page advertising, and `ads_management` permissions support the action workbench. Existing connections must reconnect to grant these stronger permissions. Ads management is requested only for the Meta Business Manager connection; Facebook, Instagram, and Threads connections do not request it.

OAuth state is enforced by the application. Meta's documented server-side Facebook Login flow does not use the server's PKCE verifier. The code exchange requests a long-lived user token, saves the actual returned expiry, and does not pretend a Facebook refresh token exists. Reconnect when that token or its permissions expire. Account read requests include `appsecret_proof` generated with HMAC-SHA256 and send the token in the Authorization header. Token exchange URLs include secrets as required by Meta's documented GET exchange; server logs and errors must never include these URLs.

Official references: [Facebook Login manual flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/), [long-lived user tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/), [secure graph requests](https://developers.facebook.com/docs/graph-api/guides/secure-requests/), [Instagram with Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/), and the [Meta SDK User edges](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/user.js) confirming `/accounts`, `/businesses`, and `/adaccounts`.

## Threads

Enable Threads in a Meta app and set `THREADS_APP_ID` and `THREADS_APP_SECRET`. These are the separate credentials shown in the app's Threads settings, not its general Meta app credentials. Add an account as a Threads tester when using development mode and complete Threads app review when needed for other users.

Threads requires an HTTPS callback using a registered domain; `localhost` redirects are unsupported. Set `APP_ORIGIN` to your deployed HTTPS origin and register the exact `/api/oauth/threads/callback` URL. The app reports this requirement before starting an unsupported localhost flow.

Requested Threads scopes are `threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`, and `threads_manage_insights`. Reconnect an existing read-only Threads connection to grant action permissions. OAuth uses `https://www.threads.com/oauth/authorize`; API calls use `https://graph.threads.com`. These current domains are taken from the official sample source (older Postman examples still use `.net`). `THREADS_API_VERSION` defaults to `v1.0` and is configurable. After code exchange, Connector exchanges the short-lived token for a long-lived token and records `expires_in`. Before expiry, verification can refresh that token using `/refresh_access_token`; expired tokens require reconnection. Threads only permits refreshing eligible long-lived tokens after they are at least 24 hours old; the application attempts refresh only within the last minute of the stored lifetime. It is not a background refresh service, so an account left unused until after expiry must reconnect.

Verification reads `/me?fields=id,username,name`. Threads' documented API uses `access_token` in server-side query parameters. The application never logs request URLs, provider response bodies, or tokens.

Official evidence: [Meta Threads sample README](https://github.com/fbsamples/threads_api/blob/main/README.md), [OAuth and profile source](https://github.com/fbsamples/threads_api/blob/main/src/index.js), and [token lifecycle API examples](https://github.com/fbsamples/threads_api/blob/main/postman/threads-api.postman_collection.json). The sample's TLS bypass option is not used; Connector keeps TLS verification enabled.

### Troubleshoot Threads connection errors

Open **Settings → Platform application settings → Threads → Manage setup** to check the saved Threads app ID, matching Threads app secret, API version (`v1.0`), and copyable redirect address. In Meta's developer dashboard, use the dedicated **Threads app ID** and **Threads app secret**, which may appear below the general app credentials in **App settings → Basic**. When correcting the ID, paste the matching revealed Threads secret too: an empty secret field preserves the previous value. Save, then start a fresh attempt from **Connections → Threads → Connect account**.

Before returning to Connector, Meta can reject a mismatched app ID, an unregistered redirect address, or an unaccepted Threads tester invitation. Register the exact displayed `/api/oauth/threads/callback` URL in the Threads configuration and accept the tester invitation while signed in to the same Threads profile you intend to connect.

After returning to Connector, an HTTP 400 alone does not identify the cause. Version 0.9.7 and later identify the failed step and, when Meta supplies them, numeric error codes/subcodes:

| Failed step | What to check |
| --- | --- |
| Authorization code exchange | The matching Threads ID/secret pair and unchanged callback address; start a fresh connection because sign-in codes expire and cannot be reused. |
| Long-lived token exchange | The Threads app secret and the new grant. Connector does not silently accept a failed token extension as a complete connection. |
| Profile verification | The authorized Threads profile, `threads_basic` permission, and Threads API version. |
| Token refresh | The existing token may need a fresh authorization; follow any expiry or permission guidance. |

Error messages never reproduce Meta's raw response text, credentials, sign-in codes, tokens, or request URLs. You can share the displayed step and numeric codes for diagnosis. A safe diagnostic message helps identify the rejected request; it does not establish that a live connection has succeeded. Existing older builds show the generic “Threads could not complete the request (HTTP 400).” message instead. Use the [account-preserving Windows update process](windows.md#update-without-reconnecting-your-accounts) when an updated signed release is available.

## Action workbench

Reconnect existing accounts after upgrading from the connection-only version so the new scopes are granted. A successful connection verifies identity/resources; it does not prove that your app has approval for every write scope. Meta app review and advanced access, required Page tasks, linked professional accounts, and the platform's messaging rules still govern each operation. The server handles permission failures without exposing access tokens or raw provider errors.

| Platform | Available actions | Constraints |
| --- | --- | --- |
| Facebook | Publish text/link Page post; list posts/comments; reply to comments; list Messenger conversations/messages; reply to Messenger; daily Page media-view insights | Page token derived from the connected user's first 100 accessible Pages; cannot post to a personal Facebook profile. Messenger replies require a recipient who contacted the Page and an eligible messaging window. |
| Instagram via Facebook Login | Publish one public HTTPS image with caption; complete existing container; list media/comments; reply to comments; list/reply to professional account messages through linked Page; account reach/views/interactions | Professional account linked to an accessible Facebook Page. Public JPEG URL and Instagram size/aspect rules apply. Container readiness is checked before publishing. Captions max 2,200 characters. Messaging requires approved `instagram_manage_messages` and an eligible recipient/window. |
| Threads | Publish text; list posts/replies; publish reply; post analytics | Text max 500 characters. Account must authorize requested Threads scopes. Threads direct messages are not exposed because this adapter does not have a documented DM API. |
| Meta Business Manager | Create paused campaign; create paused basic traffic ad set; create creative from existing Page post; create paused ad; activate/pause any delivery level; daily campaign spend; upload one website conversion | Creation alone never activates delivery. Activation can spend. The simple ad set builder supports non-special-category `OUTCOME_TRAFFIC` campaigns. Other objectives and special-category targeting require configuration in Ads Manager. |

Only independent post publication actions can be scheduled: Facebook posts, Instagram images, and Threads text. Comment replies, DMs, conversion uploads, and advertising changes cannot be scheduled. Scheduled image URLs must still be publicly accessible when the job runs. The server sends the image URL to Meta and never downloads arbitrary media URLs itself.

Facebook/Instagram actions derive a temporary Page token from `/me/accounts?fields=id,name,access_token,instagram_business_account{id}`. Page tokens are used for actions, are not returned to the browser, and are not included in action result history. All Graph requests continue to use app-secret proofs. The action response reports IDs and concise results, not raw Meta responses.

Instagram images use `/IG_ID/media`, then check the container's `status_code`, then `/IG_ID/media_publish`. If Instagram is still processing after a short bounded wait, the error includes the container ID. Use **Publish existing container** to complete that container rather than submitting the image again. If a network request fails after a write, check the platform before retrying; upstream acceptance can be uncertain.

Messenger and Instagram messaging use the official Facebook Login Page-token path shown in [Meta's Messenger Platform Python sample](https://github.com/fbsamples/messenger-platform-samples/blob/main/messenger-api/messenger-api-with-python/messenger_platform.py): Page `/conversations`, conversation `/messages`, and Page `/messages` with `messaging_type=RESPONSE`, plus `platform=instagram` for Instagram. Recipients are Page-scoped or Instagram-scoped IDs obtained from conversations, not arbitrary usernames. Both platforms normally require a reply within 24 hours of the user's interaction; this app does not add message tags to bypass that restriction. It polls conversations on request and does not operate a webhook inbox.

The [official Instagram Postman collection](https://github.com/fbsamples/messenger-platform-samples/blob/main/postman/instagram-platform-api.postman_collection.json) documents Page token discovery, media container publication, and the difference between Instagram Login (`graph.instagram.com` with Instagram user token) and Facebook Login (`graph.facebook.com` with Page token). This application uses the latter connection consistently. It does not send a Facebook Page token to an Instagram Login-only host.

Analytics use the selected API version. Page analytics requests `page_media_view` with daily periods; Instagram requests one of `reach`, `views`, or `total_interactions` with total-value aggregation; Threads post metrics are `views,likes,replies,reposts,quotes`. These APIs may omit data for unavailable history, privacy thresholds, or account eligibility. Date ranges default to seven days, and displayed collections are bounded. Direct Meta reference pages could not be retrieved in the build environment; the SDK and sample repositories were inspected and authenticated metric availability must be checked on the user's account.

### Build and activate a basic Meta website traffic ad

1. Create a paused campaign with objective **traffic** and correctly declare any special ad categories. The simple builder below supports campaigns with no special ad categories; configure regulated/special-category campaigns in Ads Manager.
2. Create a paused traffic ad set using that campaign ID, an explicit daily budget in the ad account's minor currency units, and a two-letter country code. For USD, `1000` means $10/day. This builder uses adult country-wide targeting, automatic placements, impressions billing, link-click optimization, and lowest-cost bidding.
3. Create a creative from an already published Page link post using its full `PageID_PostID`.
4. Create a paused ad with the ad set ID and creative ID.
5. Use **Activate or pause ads** for the campaign, ad set, and ad when ready. Setting `ACTIVE` can spend the configured budget once every delivery level is active, the ad is approved, and billing/account eligibility allows delivery. Use the same action with `PAUSED` to stop that level.

A campaign shell without an ad set and ad does not deliver. Ad approval, billing setup, destination validity, country rules, policy compliance, account spending limits, and Meta's minimum budgets are enforced by Meta. These operations use the official `/act_ID/campaigns`, `/adsets`, `/adcreatives`, `/ads`, and object status endpoints confirmed in the [Meta SDK AdAccount resource](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/ad-account.js) and [Campaign fields](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/campaign.js). Daily campaign insights read `spend`, impressions, clicks, CPC, and CTR; spend values use the account currency, not minor units.

### Website conversion events

The conversion form requires an actual event time within the last seven days, an event name, website HTTPS source URL, a stable event ID, customer email (or normalized email's SHA-256 hash), and an explicit confirmation that you have the required permission/consent to transmit that customer data. The server normalizes plaintext email with trim/lowercase, hashes it with SHA-256, and sends only the hash in `user_data.em`. It uses `action_source=website`. Optional value/currency data and an Events Manager test-event code are supported.

Events go to `/PIXEL_OR_DATASET_ID/events`. Use the same event ID for the same real-world event so Meta can deduplicate retries and corresponding browser events. A receipt count does not prove attribution, match quality, or reporting inclusion. The authenticated user must have the necessary access to the selected dataset; some organizations require a dedicated Conversions API/system-user setup in Events Manager. No consent is inferred from a hash. The action result excludes the email/hash and reports only event ID, receipt count, and test-event status.

Action contract tests mock HTTP requests, asserting Page-token use, secret proofs, publish sequences, comment/messaging routing, paused campaign/ad creation, budget validation, explicit activation, scalar analytics results, email hashing/consent checks, and schedule eligibility. No real posts, messages, campaign changes, conversions, or spending were performed during development.
