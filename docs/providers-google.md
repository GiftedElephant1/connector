# Google connections

These four connectors use Google's official OAuth authorization-code flow with PKCE. Connecting verifies the signed-in account and lists a preview of resources. The action panel can upload YouTube videos, reply to comments, read reports, manage Google Ads campaigns, import click conversions, manage GA4 key events, and submit or remove Search Console sitemap submissions. Write actions require confirmation in the app; scheduled video uploads run later through its persistent queue.

## One-time setup

If Google rejects the app's homepage or policy domain, use the [Google verification guide](google-verification.md) and [public website publishing instructions](public-website.md). A public, owned-domain website explains Connector and hosts the policies independently of the private workspace. Keep the workspace's actual callback URLs below; the static information site does not handle OAuth sign-ins. Branding approval, External/Internal audience restrictions, and permission-scope verification are separate checks.

1. In [Google Cloud Console](https://console.cloud.google.com/), choose a project and enable the APIs for the connectors you want: **YouTube Data API v3**, **YouTube Analytics API**, **Google Ads API**, **Google Analytics Admin API**, **Google Analytics Data API**, and **Google Search Console API**.
2. Configure the OAuth consent screen (Google Auth Platform). For a personal external app in Testing, add your Google account as a test user. Add the scopes below under Data Access. Public/external use can require Google's app verification for sensitive scopes. A Google Workspace administrator can also restrict access.
3. Create an OAuth client with application type **Web application**. Register each needed callback URL exactly as shown below, replacing `http://localhost:3000` with your `APP_ORIGIN` if different. HTTPS is required for deployed origins; Google permits localhost HTTP for development.
4. In Connector, open the platform's setup form and save your Google client ID and secret. You can reopen this form from **Settings**. The app stores these settings encrypted; do not share them in chat or commit them to GitHub.
5. For Google Ads, also save your developer token in that setup form, obtained through your Google Ads manager account's API Center. Its access level must allow the accounts you intend to use; a token limited to test accounts will not provide production access.
6. Use the relevant **Connect account** button. Google prompts you to choose an account and consent; allow the requested service scopes. Each connector stores its own encrypted OAuth credential. No restart is required after saving setup in the dashboard.

| Connector | Exact local callback | Service scope |
| --- | --- | --- |
| YouTube | `http://localhost:3000/api/oauth/youtube/callback` | `https://www.googleapis.com/auth/youtube.readonly`, `https://www.googleapis.com/auth/youtube.upload`, `https://www.googleapis.com/auth/youtube.force-ssl`, `https://www.googleapis.com/auth/yt-analytics.readonly` |
| Google Ads | `http://localhost:3000/api/oauth/google-ads/callback` | `https://www.googleapis.com/auth/adwords` |
| Google Analytics | `http://localhost:3000/api/oauth/google-analytics/callback` | `https://www.googleapis.com/auth/analytics.readonly`, `https://www.googleapis.com/auth/analytics.edit` |
| Search Console | `http://localhost:3000/api/oauth/search-console/callback` | `https://www.googleapis.com/auth/webmasters` |

Each connector also requests `openid email` to label the connection and identify the Google account. Google Ads uses its broad `adwords` OAuth scope for reads and writes. The YouTube `youtube.force-ssl` scope supports comment replies and carries wider permissions than only reading comments. Use an account role with the minimum access you need. **Reconnect existing YouTube connections** to grant the new upload, comment and analytics permissions; saved credentials from the connection-only version do not acquire scopes automatically.

**Upgrade existing Analytics and Search Console permissions:** add the new scopes above in your Google Cloud consent configuration. Then open **Connections → Google Analytics → View connection → Update permissions**, choose the same Google account, and approve the requested access. Repeat for **Google Search Console**. Old read-only tokens do not acquire write permission just by updating Connector. This flow keeps your developer settings and other connections; do not use the shared Google reset just to add permissions. If you decline consent, the previous connection remains saved.

## What verification checks

All four connectors first read `GET https://openidconnect.googleapis.com/v1/userinfo`, then their service endpoint:

| Connector | Official API request | Returned preview |
| --- | --- | --- |
| YouTube | `GET https://youtube.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50` | First page of channels owned by the selected YouTube identity, up to 50. Brand accounts may need to be selected during Google consent. |
| Google Ads | `GET https://googleads.googleapis.com/v25/customers:listAccessibleCustomers` | Up to 100 directly accessible customer resource names. This call does not recursively enumerate clients beneath manager accounts or retrieve their display names. |
| Google Analytics | `GET https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=100` | First page of account summaries and their GA4 properties, capped at 100 displayed resources. Universal Analytics is not supported. |
| Search Console | `GET https://searchconsole.googleapis.com/webmasters/v3/sites` | Up to 100 properties, excluding entries marked `siteUnverifiedUser`. Domain and URL-prefix property IDs are preserved. |

These are bounded previews, not exhaustive inventories; subsequent pages are not fetched. An empty list means Google accepted your account credential but returned no qualifying resources for this connector. The connection label states this explicitly. A failed service API request never counts as successful verification.

The app requests offline access and exchanges/refreshes tokens at `https://oauth2.googleapis.com/token`. Google can omit a refresh token or revoke access; reconnect if asked. For external OAuth apps in **Testing**, refresh tokens for these scopes generally expire after seven days. Publishing the OAuth app and, where required, verification can be necessary for longer-lived personal connections; access can still be revoked at any time. Disconnect removes the app's stored credential; revoke the grant separately in [Google Account permissions](https://myaccount.google.com/permissions) if needed.

## Publishing and inbox

YouTube **Upload a video** accepts a local video file of at most **20 MiB**, a title, description, visibility, category and made-for-kids declaration. The server sends metadata and file bytes directly to `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status&notifySubscribers=false`. It never downloads a user-supplied URL. Visibility defaults to **Private**; choose Public or Unlisted deliberately. Subscriber notifications are disabled. The upload goes to the channel selected during OAuth consent.

Google can restrict uploads from unaudited API projects to private visibility regardless of the requested visibility. The result shows the visibility returned by YouTube. An accepted upload can still be processing; inspect YouTube Studio before assuming it is playable. This lightweight multipart uploader is intended for small files, not resumable large uploads. Uploading consumes YouTube API quota. If the request times out, check YouTube Studio before retrying to avoid duplicate videos.

Scheduling queues the upload in Connector for execution at the chosen time. It is not YouTube's native `publishAt` scheduler: the app must be running and its credential must still work at that time, and YouTube processing can delay availability. The same visibility and file-size rules apply.

**Read video comments** calls `GET /youtube/v3/commentThreads` for the latest 100 published top-level comments and returns the actual comment ID needed for a reply. **Reply to a comment** calls `POST /youtube/v3/comments?part=snippet` and creates a public reply. Disabled comments, moderation and channel permissions may prevent replies. The app does not fetch held-for-review comments or all nested replies. YouTube does not offer a general official direct-messaging API, so DMs are unsupported.

## Google Ads actions

All actions require the advertising customer ID. When using a manager account, supply the optional **Manager customer ID**; it is sent as `login-customer-id`. The existing developer token must permit the intended account and action, and the Google user must have the necessary account role.

| Action | Official v25 request | Behavior |
| --- | --- | --- |
| List campaigns | `POST /customers/{id}/googleAds:search` | GAQL query, at most 100 non-removed campaigns. |
| Create paused Search campaign | `POST /customers/{id}/googleAds:mutate` | Creates a dedicated daily budget and Search campaign atomically with `partialFailure:false`. The campaign is always **PAUSED**, uses manual CPC, and targets Google Search only. |
| Enable or pause campaign | `POST /customers/{id}/campaigns:mutate` | Updates only the campaign's `status`. Enabling allows eligible ads to serve and spend. |
| Read campaign spend | `POST /customers/{id}/googleAds:search` | Daily cost, clicks, impressions and conversions, including account currency. At most 100 campaign/day rows, not a complete account total. |
| Upload click conversion | `POST /customers/{id}:uploadClickConversions` | Imports one GCLID-based conversion with the declared value, currency, time and consent. |

Budget amounts are average daily budgets in the **Google Ads account's currency**, converted exactly to integer micros. They are not lifetime caps or strict per-day ceilings; Google's budget rules permit daily spending above the average. The EU political advertising declaration must reflect the campaign's actual content. The campaign builder creates a paused campaign and budget only: set its ad groups, bids, keywords, creatives, targeting, billing and other settings in Google Ads before enabling it here. The app does not yet build a complete Search ad or support every campaign type. Enabling a campaign does not bypass Google approval or guarantee delivery.

Click conversion upload requires a suitable **import from clicks** conversion action, a real eligible GCLID, and a conversion timestamp after the click with an explicit UTC offset (`YYYY-MM-DD HH:mm:ss+HH:mm`). Supply the actual `GRANTED` or `DENIED` consent for `adUserData`; the app does not invent consent. `adPersonalization` is intentionally omitted because Google's click-upload schema does not support it. For cross-account conversion tracking, supply the conversion owner's full `customers/{id}/conversionActions/{id}` resource. An optional stable order ID helps Google recognize duplicate transactions. This action does not set up website tagging, create conversion actions, upload customer lists, or implement enhanced conversions using hashed personal identifiers.

The conversion API requires `partialFailure:true`; the adapter inspects `partialFailureError`, top-level errors and missing result confirmations, including HTTP 200 responses, and never presents these as a successful upload. A successful import acknowledgment is not proof of final attribution. Check Google Ads upload diagnostics and reporting after processing. Check the platform before retrying an ambiguous write.

## Analytics actions

Reports accept real `YYYY-MM-DD` start and end dates, including both endpoints, covering at most 366 days. They return at most 100 rows without automatically paging, so long ranges can be incomplete.

- **YouTube channel analytics:** `GET https://youtubeanalytics.googleapis.com/v2/reports`, `ids=channel==MINE`, daily `views` and `estimatedMinutesWatched`. Dates use the provider's reporting time zone. No revenue/monetary scope is requested.
- **GA4 daily traffic:** `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`, daily `activeUsers`, `sessions` and `screenPageViews` in the property's reporting time zone. Requires the numeric GA4 property ID, property access, and the Google Analytics Data API enabled in the project. Empty or delayed data is returned as empty data, not fabricated activity.
- **Search Console performance:** `POST https://searchconsole.googleapis.com/webmasters/v3/sites/{encoded-property}/searchAnalytics/query`, final web-search data grouped by date, with clicks, impressions, CTR and average position. Dates use Pacific time; the property must match the exact domain or URL-prefix ID. The property is encoded as an API path parameter and is never fetched as an external URL.

## Analytics and Search Console writes

- **List GA4 key events** returns up to 100 configured events with the IDs needed for editing. **Create a GA4 key event** marks an event name for future key-event measurement; **Change a GA4 key event counting method** chooses once per event or once per session. These use the Analytics Admin API and require its `analytics.edit` scope plus Editor or Administrator access to the property. They do not emit measurement events or rewrite past reports.
- **Submit a sitemap** sends a sitemap URL to a Search Console property you can manage. **Remove a sitemap submission** removes its entry from the Sitemaps report. It does not delete your sitemap file, stop Google's crawling, or remove indexed pages. Submission acceptance does not guarantee indexing. Both operations need the `webmasters` scope and a suitable property role.
- Your AI agent can discover these actions with `list_actions` and perform an approved write with `run_action`. The same confirmation and request-ID safeguards used for other writes apply. No additional AI developer API key is needed for an existing MCP connection.

## Network access and validation

Allow outbound HTTPS to `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `youtube.googleapis.com`, `www.googleapis.com`, `youtubeanalytics.googleapis.com`, `googleads.googleapis.com`, `analyticsadmin.googleapis.com`, `analyticsdata.googleapis.com`, and `searchconsole.googleapis.com`. Google consent may load other Google login assets in the browser.

Automated tests mock Google responses and cover PKCE, code exchange, refresh, per-service scopes, request headers, resource parsing, bounded video uploads, campaign payloads, decimal budget precision, conversion partial failures, report requests, empty accounts, and safe errors. Real-account verification, publishing, campaigns, conversions and reporting need your developer configuration and consent and are not established by successful mock tests. No live write is performed during automated tests.

## Official references

- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) and [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [YouTube channels.list](https://developers.google.com/youtube/v3/docs/channels/list); [official discovery definition](https://github.com/googleapis/google-api-python-client/blob/main/googleapiclient/discovery_cache/documents/youtube.v3.json)
- [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert), [comments.insert](https://developers.google.com/youtube/v3/docs/comments/insert), [YouTube Analytics reports](https://developers.google.com/youtube/analytics/reference/reports/query)
- [Google Ads listing accessible accounts](https://developers.google.com/google-ads/api/docs/account-management/listing-accounts); [official v25 HTTP mapping](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/services/customer_service.proto); [supported Python client versions](https://github.com/googleads/google-ads-python/blob/main/google/ads/googleads/client.py)
- [Analytics accountSummaries.list](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list); [official discovery definition](https://github.com/googleapis/google-api-python-client/blob/main/googleapiclient/discovery_cache/documents/analyticsadmin.v1beta.json)
- [GA4 runReport](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport); [Google Ads atomic mutations](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/services/google_ads_service.proto); [click conversion schema](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/services/conversion_upload_service.proto); [consent field applicability](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/common/consent.proto)
- [Search Console sites.list](https://developers.google.com/webmaster-tools/v1/sites/list); [official discovery definition](https://github.com/googleapis/google-api-python-client/blob/main/googleapiclient/discovery_cache/documents/searchconsole.v1.json)
- [GA4 key events](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties.keyEvents); [Search Console sitemap submission](https://developers.google.com/webmaster-tools/v1/sitemaps/submit) and [removal](https://developers.google.com/webmaster-tools/v1/sitemaps/delete)

API routes and Google Ads v25 support were checked against Google's published discovery documents and SDK/protobuf sources on 2026-10-13. Ads API versions have a support lifecycle; upgrade the adapter when Google sunsets v25.
