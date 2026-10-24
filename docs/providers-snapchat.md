# Snapchat publishing and advertising

Connector has two independent Snapchat connections. **Snapchat** uses the Public Profile API for organic content. **Snapchat Ads** uses the Marketing API for advertising accounts, campaigns and reporting. A successful sign-in to one does not grant the permissions or connect the accounts used by the other.

## Before connecting

Create an OAuth application from **Snap Business Manager / Ads Manager → Business Details**, using an organization administrator account. This is the Business OAuth application, not a Snap Kit Login Kit or Creative Kit application. Keep its client secret in Connector’s authenticated setup screen; do not share it in chat or place it in a redirect URL.

The Public Profile API is currently **allowlist-only**. Request access through your Snap contact and provide the public OAuth client ID, not its secret. You need a Snapchat Public Profile and the permissions to manage it. Snap supports standard and verified Public Profiles; the app does not assume that every connected account is a Snap Star or that OAuth approval alone grants publishing rights.

Advertising access requires a Snapchat user with the appropriate role on the intended advertising account. Snapchat’s app access, account eligibility, media rules, billing and review requirements still apply. No live publishing or advertising approval is included with Connector.

## Application settings and callbacks

Use **Settings → Platform application settings → Manage setup** for each connection. The setup screen supplies the current callback based on Connector’s public HTTPS address.

| Connection | Saved settings | Requested OAuth scope | Callback |
| --- | --- | --- | --- |
| Snapchat | `SNAPCHAT_CLIENT_ID`, `SNAPCHAT_CLIENT_SECRET`; optional `SNAPCHAT_ORGANIZATION_ID` | `snapchat-profile-api` | `APP_ORIGIN/api/oauth/snapchat/callback` |
| Snapchat Ads | `SNAPCHAT_ADS_CLIENT_ID`, `SNAPCHAT_ADS_CLIENT_SECRET` | `snapchat-marketing-api` | `APP_ORIGIN/api/oauth/snapchat-ads/callback` |

1. Start public access and open the public Connector workspace. Use the running app’s address, not a static marketing website.
2. Register the exact callback shown for the connection in the Snapchat OAuth app. Keep the path and scheme unchanged.
3. Paste the matching client ID and client secret into Connector and save.
4. Complete Snapchat’s authorization screen using the user who manages the target Public Profile or advertising account.
5. Open **View connection → Available resources** and identify the intended profile or ad account before asking your AI to act on it.

If you deliberately use the same approved Snapchat OAuth application for both connections, register both callback URLs and enter the app credentials in both setup screens. The values and grants remain separate in Connector. Resetting either connection does not clear the other connection’s settings or token.

For company profiles managed by a business organization, enter its organization ID in **Snapchat organization ID** before connecting. Without it, Connector checks the Public Profile belonging to the authorizing user. An organization ID, Public Profile ID and advertising account ID identify different resources and are not interchangeable.

## Publish content through your AI connection

Ask your authorized AI to call `list_connections`, then `list_actions` with `provider="snapchat"`. Use the exact schemas it returns; do not guess action fields from a different social platform.

The publishing actions accept local image/video bytes as a base64 data URL, with a maximum of **20 MiB of decoded media**. Build the data URL in code from the file without printing the bytes into chat. Connector encrypts the media, creates its Snapchat media container, uploads and finalizes the parts, then submits the Story or Spotlight post to the selected Public Profile. It does not fetch arbitrary media URLs or treat a media URL as a completed upload.

| Action | Inputs and limits |
| --- | --- |
| `list-profiles` | Organization ID; optional pagination cursor. Lists the organization’s Public Profiles. |
| `list-stories` | Public Profile ID; optional cursor. Reads a bounded content page. |
| `list-spotlights` | Public Profile ID; optional cursor. Reads a bounded content page. |
| `publish-story` | Public Profile ID, private upload name, JPEG/PNG/MP4 media data URL, optional attachment link. |
| `publish-spotlight` | Public Profile ID, private upload name, MP4 media data URL, optional description up to 160 characters and locale (default `en_US`). |

The upload name labels the media container; it is not a Story caption or a text overlay. Add text to the source image/video before submitting if you want it visible. Snapchat validates video duration and resolution: the referenced API requires Story videos of 5–60 seconds and Spotlight videos of 6–60 seconds, with minimum dimensions of 540×960. Connector checks file type/header and byte size locally; it does not transcode media or claim to validate every Snapchat media rule.

Writes require the user’s approval for the exact media, target and content, `confirmed=true`, and a unique `requestId`. Reuse that request ID only for the same submission. If a response is uncertain, check the profile and job result before submitting again with another request ID.

Stories and Spotlight submissions can be scheduled through `schedule_post`. The encrypted job stores the supplied media and uploads it when the scheduled action runs; it does not depend on a media container uploaded days earlier. Keep the Connector PC running, awake and online. Snapchat still enforces its current media eligibility and moderation rules at execution time.

A successful API submission is not a guarantee that content is visible. Check the returned result, subsequent content listings and Snapchat itself. Private Snaps, direct messages, camera controls, lenses and every feature of Snapchat’s consumer app are outside this integration.

## Advertising actions

Ask the AI to call `list_actions` with `provider="snapchat-ads"`. Select the verified advertising account ID explicitly. Connector exposes account and campaign reads, campaign creation in a paused state, status changes, daily-budget changes and spend reporting. List responses are bounded previews, not guaranteed complete inventories.

Budget amounts must use the advertising account’s currency. Connector sends the API’s integer micro-currency units and reports those units explicitly. Enabling an eligible campaign or increasing its budget may cause spending; each write requires confirmation and a unique request ID. Creating a paused campaign alone does not create the ad squads, targeting, creatives, ads or billing needed for delivery.

Reporting is a read operation. It does not change attribution, fabricate conversions or alter historical spend. Inspect the action schema for the supported reporting window, timezone and fields.

| Action | Scope and limits |
| --- | --- |
| `list-ad-accounts` | First 100 visible advertising accounts, with currency, timezone and account roles when returned. |
| `list-campaigns` | First 100 campaigns for the selected advertising account. |
| `create-campaign` | One paused auction awareness-and-engagement campaign with a daily spending cap. Optional explicit start timestamp. |
| `set-campaign-status` | Set one existing campaign to `ACTIVE` or `PAUSED`; activating can start spend. |
| `set-campaign-budget` | Change an existing daily spending cap while preserving status and other campaign settings. |
| `read-spend` | Account totals, or totals for one optional campaign, across an explicit start/end window of at most 31 calendar days. ISO timestamps must include an offset and represent midnight in the advertising account’s timezone; end is exclusive. Daylight-saving offsets may differ between start and end. Returns spend, impressions and swipes when available, rather than a daily series. |

## Troubleshooting

- **Public Profile access denied:** confirm that Snap has allowlisted the exact OAuth client ID for the Public Profile API, then verify that the authorizing user manages the intended profile. Marketing API approval does not grant Public Profile API access.
- **No intended company profile:** check the optional organization ID and the user’s profile role. Reconnect or verify after correcting setup; do not substitute an advertising account ID.
- **Redirect mismatch:** register the complete callback shown in the matching setup screen. Update it if your public Connector address changes.
- **Ads access denied:** check the separate Ads credentials, Marketing API access and the user’s advertising account role.
- **Media rejected:** use the action’s supported format and size, check Snapchat’s current media requirements, and inspect the target profile before retrying a submission that may already have been accepted.
- **Expired access:** Connector refreshes expiring OAuth tokens when supported. If access was revoked or refresh is rejected, reconnect that Snapchat connection.

## Official references

- [Public Profile API access and authentication](https://developers.snap.com/marketing-api/Public-Profile-API/GetStarted)
- [Public Profile content and media management](https://developers.snap.com/marketing-api/Public-Profile-API/ProfileAssetManagement)
- [Marketing API authentication](https://developers.snap.com/marketing-api/Ads-API/authentication)

The implementation and automated tests exercise the documented request formats and connection boundaries. Actual Snapchat approval, permissions and publication must be verified with your own account after setup.
