# Social and WordPress connections

These adapters connect and verify accounts, then expose supported publishing, inbox and analytics actions. A connection is saved only after a successful authenticated read of the official account API. Publishing actions can be scheduled by Connector; replies and direct messages require a separate explicit action. The scheduler must be running when a job is due. These adapters do not create advertising campaigns.

**Reconnect accounts authorized by the earlier connect-only version.** Its tokens do not have the new publishing or inbox scopes. Enable the corresponding products and obtain any required approval before reconnecting.

Create your own developer application for each service you want to use. Register the exact callback shown below, replacing `https://connector.example` with `APP_ORIGIN`. Use HTTPS for hosted installations; services can reject localhost or insecure callbacks. Client secrets stay in the server environment. Consumer subscriptions and being signed into a platform in your browser do not replace developer application credentials, app approval, or OAuth consent.

| Connection | Server settings | Callback path | Requested permissions |
| --- | --- | --- | --- |
| X (Twitter) | `X_CLIENT_ID`, `X_CLIENT_SECRET` | `/api/oauth/x/callback` | `tweet.read tweet.write users.read dm.read dm.write offline.access` |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | `/api/oauth/tiktok/callback` | `user.info.basic`, `video.publish`, `video.list` |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | `/api/oauth/linkedin/callback` | `openid profile w_member_social`; optional restricted `r_member_social`; company opt-in adds `rw_organization_admin r_organization_social w_organization_social` |
| Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` | `/api/oauth/reddit/callback` | `identity read submit privatemessages` with `duration=permanent` |
| Pinterest | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` | `/api/oauth/pinterest/callback` | `user_accounts:read`, `boards:read`, `boards:write`, `pins:read`, `pins:write` |
| WordPress | `WORDPRESS_CLIENT_ID`, `WORDPRESS_CLIENT_SECRET` | `/api/oauth/wordpress/callback` | Default grant for the site selected on WordPress.com; no `global` scope |

## X (Twitter)

Start with the [complete X developer-account setup guide](providers-x.md), also available under **Connections → X (Twitter) → Connect account → Set up X step by step**. It covers account registration, API access, app creation, OAuth settings, the exact URLs and scopes, and copying the two credentials into Connector without terminal commands.

Enable OAuth 2.0 in an X developer app configured as a confidential web application. API access, product availability, and any billing requirements are controlled by X. The adapter uses authorization code with PKCE S256, client authentication, and a refresh token when `offline.access` is granted. Write and DM scopes are requested for the actions below.

- Authorize: `https://x.com/i/oauth2/authorize`
- Exchange and refresh: `POST https://api.x.com/2/oauth2/token`
- Verify: `GET https://api.x.com/2/users/me`
- Sources: [OAuth 2.0 authorization code](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), [official SDK OAuth flow](https://github.com/twitterdev/twitter-api-typescript-sdk/blob/main/src/OAuth2User.ts), [official SDK user endpoints](https://github.com/twitterdev/twitter-api-typescript-sdk/blob/main/src/gen/Client.ts).

## TikTok

Start with the [complete TikTok setup and review guide](tiktok-review.md#1-create-the-developer-account-and-connect-tiktok). It covers developer-account registration and email verification, the real operator profile, creating the Web application, every supplied app/URL field, product and scope selection, redirect/domain verification including the in-app TikTok text-file uploader, sandbox target-user authorization, copying the client key and secret into Connector, and connecting the account. It then covers media-source verification, the real MP4/MOV demo, and final review submission.

The same instructions and copyable values are inside **Connections → TikTok → Connect account → Prepare TikTok submission** when setup is required, or **Settings → TikTok app review → Prepare TikTok submission**. Use **Save and continue** after pasting the **TikTok client key** and **TikTok client secret**. Setup opened from **Connect account** continues to TikTok's OAuth screen; editing settings alone saves the credentials, after which you choose **Connect account**. Creating a TikTok developer application does not require Anthropic, OpenAI, or xAI developer credentials.

This distribution's public operator is **Vectre Pay Inc** and its public contact is **contact@vectrepay.com**. Your supplied public base address is **https://speak-moonwalk-granola.ngrok-free.dev**; always copy the currently configured values from Connector if that address changes. The guide includes the built-in policy URLs, icon, copy-ready app description and scope explanation, and a recording checklist. A real sandbox authorization and demonstration still require your developer app and test account; app review and ownership verification are controlled by TikTok.

Configure Login Kit, Display API and Content Posting API for a web application, register the callback, and obtain access to the requested scopes. TikTok requires review for production use; sandbox accounts must be registered as test users in the developer portal. Login Kit is distinct from TikTok for Business and its advertiser permissions. This adapter uses the confidential web flow; desktop-only PKCE requirements are not applied to the web flow.

- Authorize: `https://www.tiktok.com/v2/auth/authorize/`
- Exchange and refresh: `POST https://open.tiktokapis.com/v2/oauth/token/` with `client_key` and `client_secret`
- Verify: `GET https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name`
- The API's `error.code` must be `ok`, as HTTP 200 alone is not proof of success. Rotated refresh tokens are retained.
- Sources: [Login Kit for web](https://developers.tiktok.com/doc/login-kit-web), [access token management](https://developers.tiktok.com/doc/oauth-user-access-token-management), [user information API](https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info).

## LinkedIn

For company Pages, follow [Connect a company Page](providers-linkedin.md#connect-a-company-page). Enable **Approved LinkedIn company pages** only after the three organization scopes are approved, then update permissions. Connector discovers approved super-admin/content-admin Pages with pagination, includes them alongside the member profile, and exposes `list-organizations`, `organization-posts`, and `publish-organization` to AI apps. Company actions require an explicit organization URN and recheck access; they do not fall back to the member profile.

If LinkedIn says **“The redirect_uri does not match the registered value”**, follow the [LinkedIn redirect repair instructions](providers-linkedin.md). The LinkedIn card’s **Check LinkedIn setup** button shows both exact redirect URLs and the Client ID to match, even when credentials are already saved.

Add **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn** to a LinkedIn developer app. Follow LinkedIn's requirements for an associated company page and app verification. LinkedIn Campaign Manager is a separate connection with separate product access. `w_member_social` supports member publishing; comment-read access additionally requires restricted `r_member_social` approval. Only after that approval, set `LINKEDIN_ENABLE_MEMBER_READ=true` and reconnect. Do not enable it for ordinary Sign In / Share applications: LinkedIn will reject an unauthorized scope. `LINKEDIN_API_VERSION` defaults to `202601` and must be updated to a supported release before that version is retired.

- Authorize: `https://www.linkedin.com/oauth/v2/authorization`
- Exchange and, when eligible, refresh: `POST https://www.linkedin.com/oauth/v2/accessToken`
- Verify: `GET https://api.linkedin.com/v2/userinfo`
- LinkedIn does not issue programmatic refresh tokens to every application. Connector refreshes only when a token was issued; otherwise reconnect when access expires.
- Sources: [Sign In with LinkedIn using OpenID Connect](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2), [authorization code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow), [programmatic refresh tokens](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens), [official SDK exchange and refresh implementation](https://github.com/linkedin-developers/linkedin-api-js-client/blob/master/lib/auth.ts).

## Reddit

Use a confidential **web app**, with a client ID, client secret and exact redirect URI. Access remains subject to Reddit's API approval and usage terms; creating an app does not guarantee API access. Set an identifying `REDDIT_USER_AGENT`, for example `web:your-connector:0.1 (by /u/your_username)`. Avoid generic or misleading user agents. The adapter sends it on token and API requests.

- Authorize: `https://www.reddit.com/api/v1/authorize`
- Exchange and refresh: `POST https://www.reddit.com/api/v1/access_token`, using HTTP Basic client authentication
- Verify: `GET https://oauth.reddit.com/api/v1/me`
- `duration=permanent` requests a refresh token; subsequent refresh responses can omit it, in which case Connector retains the existing refresh token.
- Sources: [official Reddit OAuth documentation](https://github.com/reddit-archive/reddit/wiki/OAuth2), [API rules](https://github.com/reddit-archive/reddit/wiki/API), [identity endpoint](https://www.reddit.com/dev/api/#GET_api_v1_me), [Reddit developer access guidance](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Reddit-Developer-Interfaces).

## Pinterest

Create a Pinterest developer app and request the appropriate access tier. Trial access is restricted to eligible accounts and collaborators; wider use requires Pinterest review and Standard access. Board and Pin permissions support creating a Pin on an existing board. Pinterest's official OpenAPI permission mapping for Pin creation includes both `boards:read` and `boards:write` along with `pins:read` and `pins:write`, although Connector does not create or edit boards. Advertising scopes are not requested by this adapter.

- Authorize: `https://www.pinterest.com/oauth/`
- Exchange and refresh: `POST https://api.pinterest.com/v5/oauth/token`, using HTTP Basic client authentication
- Verify: `GET https://api.pinterest.com/v5/user_account`
- Exchanges include `continuous_refresh=true` for compatibility with apps created before September 25, 2025. Pinterest's official API definition says those apps must request continuous refresh tokens; new apps receive them automatically. Refresh tokens still expire when their refresh window is missed, and revoked access requires reconnection.
- Sources: [authentication and authorization](https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/), [official API v5 definition: `/oauth/token`, `/user_account`, `OauthAccessTokenCreate`](https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml).

## WordPress

Register an application with WordPress.com. This version supports WordPress.com and eligible self-hosted sites connected to the same WordPress.com account through Jetpack. Standalone self-hosted WordPress sites and Application Password authentication are not included. The server never accepts or fetches a user-supplied WordPress API URL.

WordPress.com uses coarse OAuth grants. Connector omits `scope=global` to keep the default grant limited to the site selected on the WordPress consent screen. This grant includes the applicable post and comment operations. Review WordPress's consent screen before connecting. Returned site resources are whatever the grant permits; this is not a promise that all sites on an account will be accessible.

- Authorize: `https://public-api.wordpress.com/oauth2/authorize`
- Exchange: `POST https://public-api.wordpress.com/oauth2/token`
- Verify identity: `GET https://public-api.wordpress.com/rest/v1.1/me`
- Verify sites: `GET https://public-api.wordpress.com/rest/v1.1/me/sites`
- Up to 100 returned sites are displayed. Tokens are used until invalid or revoked; no unsupported refresh endpoint is invented.
- Sources: [WordPress.com OAuth](https://developer.wordpress.com/docs/oauth2/), [current user](https://developer.wordpress.com/docs/api/1.1/get/me/), [user sites](https://developer.wordpress.com/docs/api/1.1/get/me/sites/), [official OAuth client defaults](https://github.com/Automattic/node-wpcom-oauth/blob/master/default.json), [official OAuth client exchange](https://github.com/Automattic/node-wpcom-oauth/blob/master/index.js), [official account and sites client](https://github.com/Automattic/wpcom.js/blob/master/lib/me.js).

## Network access and validation

Browser authorization uses `x.com`, `www.tiktok.com`, `www.linkedin.com`, `www.reddit.com`, `www.pinterest.com`, and `public-api.wordpress.com`. Server calls use `api.x.com`, `open.tiktokapis.com`, `www.linkedin.com`, `api.linkedin.com`, `www.reddit.com`, `oauth.reddit.com`, `api.pinterest.com`, and `public-api.wordpress.com`. Provider sign-in pages may use additional domains controlled by that provider.

Tests exercise authorization parameters, code exchange authentication, PKCE, account response validation, TikTok's HTTP-200 error handling, refresh token rotation and preservation, credential validation, bounded WordPress site resources, fixed official API URLs, publishing payloads, comment/message parent relationships, explicit TikTok choices, and safe error handling. They use mocked HTTP responses. Successful live connections and actions still require your registered apps, any provider approval and OAuth consent. Direct developer documentation hosts were blocked by the build environment's network proxy; available official GitHub SDK and OpenAPI sources were used to cross-check the implemented flows. No live account authorization, publishing or messaging was performed during development.

## Supported actions and platform limits

| Platform | Publishing / scheduling | Inbox | Analytics |
| --- | --- | --- | --- |
| X | Text posts | Recent conversation replies, public replies, recent DM events, one-to-one DM send/reply | Public post metrics; eligible owned-post metrics |
| TikTok | Direct Post from a provider-verified HTTPS video URL, creator options, publication status | No general Login Kit comment or DM API implemented | Owned-video counts exposed by Display API |
| LinkedIn | Member text posts; company text posts and recent post reads with organization opt-in | Member comment/reply writes when approved; member comment reads require restricted approval. Company comments not exposed. | Member analytics not exposed by standard Sign In / Share products; omitted |
| Reddit | Text and link posts | Post comments and replies; legacy private-message inbox/send/reply | Public score, comment count and upvote ratio |
| Pinterest | Image Pins from HTTPS URLs, board discovery | No supported general comment or DM API implemented | Eligible Pin analytics |
| WordPress | Posts, recent-post discovery | Post comments and replies | WordPress.com / eligible Jetpack Stats summary |

The interface shows only supported operations. Successful connection does not guarantee approval for every action. List actions return bounded recent results, not a complete synchronized inbox. There is no automatic reply bot. Only publishing actions can be scheduled, and the app must stay running for scheduled work. A network timeout can occur after a provider accepted a write; check the platform before retrying to avoid duplicates. A submitted video or moderated post may not yet be publicly visible.

### X action endpoints

- `POST https://api.x.com/2/tweets`: publish text, or reply with `reply.in_reply_to_tweet_id`.
- `GET https://api.x.com/2/tweets/search/recent?query=conversation_id:ID`: up to 25 recent replies; recent-search retention and API entitlement apply.
- `GET https://api.x.com/2/dm_events`: up to 25 recent direct-message events.
- `POST https://api.x.com/2/dm_conversations/with/USER_ID/messages`: send a one-to-one DM to a permitted recipient. This does not send to arbitrary group conversations.
- `GET https://api.x.com/2/tweets/ID?tweet.fields=public_metrics`: public metrics. The owned-post option also requests `non_public_metrics` and `organic_metrics`; those are limited to authorized recent owned posts and eligible API access.
- Sources: [official generated X client](https://github.com/twitterdev/twitter-api-typescript-sdk/blob/main/src/gen/Client.ts), [manage posts](https://docs.x.com/x-api/posts/create-post), [direct messages](https://docs.x.com/x-api/direct-messages/introduction), [post metrics](https://docs.x.com/x-api/fundamentals/metrics).

### TikTok action endpoints and review requirements

- `POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/`: retrieve current creator options. Run **Check publishing options** and review the creator and allowed privacy values before preparing content.
- `POST https://open.tiktokapis.com/v2/post/publish/video/init/`: submit with `source_info.source=PULL_FROM_URL`. TikTok, not Connector, fetches the URL. The domain or URL prefix must be verified in your TikTok developer settings. Connector rechecks current creator options before submission, requires an explicit valid privacy choice, honors creator-disabled interactions and records the chosen branding/AI flags.
- `POST https://open.tiktokapis.com/v2/post/publish/status/fetch/`: poll a returned `publish_id`. Submission is not a publication success; check for the provider's completed status and review any failure reason.
- `POST https://open.tiktokapis.com/v2/video/query/`: use `video.list` to read an owned video's views, likes, comment count and shares.
- Unaudited Direct Post applications are restricted, including private-only visibility. TikTok reviews the complete user experience and may reject an internal cross-posting utility or an app that does not satisfy its posting guidelines. API adapter support does not imply that TikTok has approved this application. The media must meet TikTok duration/format requirements. The app does not download it to inspect or edit it.
- Users must explicitly agree to TikTok's [Music Usage Confirmation](https://www.tiktok.com/legal/page/global/music-usage-confirmation/en) and, for branded content, [Branded Content Policy](https://www.tiktok.com/legal/page/global/bc-policy/en). The form requires a consent selection and explicit interaction, privacy, brand and AI choices; the deployment owner must ensure their complete reviewed UI meets TikTok's current requirements.
- TikTok Login Kit / Display API does not grant a general comments or DM inbox. Restricted partner or business messaging products require separate approval and integrations and are not represented as available here.
- Sources: [Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post), [creator information](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info), [publication status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status), [video query](https://developers.tiktok.com/doc/tiktok-api-v2-video-query), [Content Posting guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines).

### LinkedIn action endpoints

- `POST https://api.linkedin.com/rest/posts`: publish a member text post with `w_member_social`. The actor is derived from the connected member's `userinfo`, not an arbitrary user-supplied actor.
- `GET https://api.linkedin.com/rest/socialActions/POST_URN/comments`: read up to 25 comments only after restricted `r_member_social` approval and opt-in configuration.
- `POST https://api.linkedin.com/rest/socialActions/POST_URN/comments`: create a top-level comment or reply using a full `parentComment` URN. Social Actions product approval and member access restrictions still apply.
- Requests send `LinkedIn-Version` and `X-Restli-Protocol-Version: 2.0.0`. Standard Sign In/Share products do not provide unrestricted member-post analytics or a member DM inbox; those actions are omitted. Organization/advertising permissions are not silently substituted for member permissions.
- Sources: [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api), [Comments API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api), [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin).

### Reddit action endpoints

All use `https://oauth.reddit.com` and the configured identifying user agent.

- `POST /api/submit`: text (`kind=self`) or HTTPS link (`kind=link`) post, with `submit` scope. Subreddit rules and moderation apply.
- `GET /comments/POST_ID`: top-level comment listing with `read` scope.
- `POST /api/comment`: public reply to a `t3_` post or `t1_` comment using `submit`; private-message reply to a `t4_` message using `privatemessages`.
- `GET /message/inbox` and `POST /api/compose`: legacy Reddit private messages and notifications. This is not the Reddit Chat product, which does not offer the same public API.
- `GET /api/info?id=t3_POST_ID`: public engagement. Score is vote-fuzzed by Reddit; these are not impression or reach analytics.
- JSON-level `json.errors` is checked even for HTTP 200; an error is never shown as a successful submission.
- Sources: [Reddit API reference](https://www.reddit.com/dev/api/), [official OAuth scope documentation](https://github.com/reddit-archive/reddit/wiki/OAuth2).

### Pinterest action endpoints

- `GET https://api.pinterest.com/v5/boards`: list available boards.
- `POST https://api.pinterest.com/v5/pins`: create an image Pin with `media_source.source_type=image_url`. Pinterest retrieves the HTTPS media; Connector makes no request to that media host.
- `GET https://api.pinterest.com/v5/pins/PIN_ID/analytics`: request `IMPRESSION`, `SAVE`, `PIN_CLICK` and `OUTBOUND_CLICK` in a validated date range. Ownership, account type, retention and access-tier restrictions apply. Only returned summary metrics are displayed.
- Pinterest's general API does not provide a comments/DM inbox for this integration.
- Source: [official OpenAPI: `/boards`, `/pins`, `/pins/{pin_id}/analytics`](https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml).

### WordPress action endpoints

All use `https://public-api.wordpress.com/rest/v1.1/sites/SITE_ID` with a numeric WordPress.com site ID. Standalone arbitrary site URLs remain unsupported.

- `POST /posts/new`: create with `status=publish`; the returned status can still reflect editorial permissions.
- `GET /posts/`: list recent posts.
- `GET /posts/POST_ID/replies/`: list post comments.
- `POST /comments/COMMENT_ID/replies/new`: reply to a specific parent comment. Site moderation may hold replies.
- `GET /stats`: read the statistics summary permitted by the WordPress.com grant and site/Jetpack plan. This is not a universal analytics API for every self-hosted site.
- Sources: [post creation](https://developer.wordpress.com/docs/api/1.1/post/sites/%24site/posts/new/), [comment replies](https://developer.wordpress.com/docs/api/1.1/post/sites/%24site/comments/%24comment_ID/replies/new/), [site statistics](https://developer.wordpress.com/docs/api/1.1/get/sites/%24site/stats/), [official post client](https://github.com/Automattic/wpcom.js/blob/master/lib/site.post.js), [official comment client](https://github.com/Automattic/wpcom.js/blob/master/lib/site.comment.js).
