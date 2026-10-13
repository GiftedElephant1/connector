# Prepare Connector for TikTok app review

Connector includes public app-information, Terms of Service, and Privacy Policy pages, an original app icon, and a **TikTok app review** setup panel. These help you prepare your submission. TikTok still decides whether your actual app, intended use, selected products, and recording meet its review requirements.

**Check the intended-use requirements before submitting Direct Post.** Connector is a self-hosted, personal AI-to-account pipeline. TikTok's Content Posting guidelines exclude internal utilities that upload to accounts managed by the developer or their team. That limitation is relevant to this use: adding policy pages or a recording does not change it. Describe the real personal use honestly; do not claim a public creator service or an existing approval. Sandbox testing is not production approval. If TikTok will not approve this use, remove Content Posting API / `video.publish` from the application and do not represent TikTok publishing as available. The connector's requested scopes must also be adjusted before connecting a reduced-scope application.

## 1. Publish your app information and policies

1. Start Connector from your existing installation and sign in.
2. Open **Settings**. Under **Make Connector available to your AI agent**, start public access if it is not already running.
3. Click **Open public workspace**. Sign in at that HTTPS address. Keep the PC awake, Connector running, and the tunnel available during review.
4. In **Settings**, find **TikTok app review**, then click **Prepare TikTok submission**. This distribution is configured for **Vectre Pay Inc**, with **contact@vectrepay.com** as the public contact email. Review these details and the policy pages; if you change them, click **Save public page details**. Previously saved operator details take precedence. These contact details are visible to anyone who opens the policy pages. An incomplete saved profile shows a setup-incomplete notice; do not submit unfinished pages.
5. Copy the generated public URLs from that panel. Use the URLs from your own running app, not a GitHub source-file URL, localhost address, or the examples below.
6. Open each URL in a signed-out/incognito browser window. Confirm it loads without a Connector password and shows the correct operator and contact details. An ngrok browser interstitial or offline tunnel can interfere with review; check what a new visitor actually sees.
7. Keep the same public domain throughout the application and recording. If the public address changes, update the website, policy URLs, Login Kit redirect URL, and any verified-domain configuration in TikTok's Developer Portal before submitting.

| TikTok application field | Value to copy from Connector |
| --- | --- |
| App name | `Connector` |
| Website URL | `https://YOUR-PUBLIC-DOMAIN/about` |
| Terms of Service URL | `https://YOUR-PUBLIC-DOMAIN/terms` |
| Privacy Policy URL | `https://YOUR-PUBLIC-DOMAIN/privacy` |
| Login Kit redirect URI | `https://YOUR-PUBLIC-DOMAIN/api/oauth/tiktok/callback` |
| App icon | Download the PNG using **TikTok app review** and upload that file |

The policy pages describe this installation's behavior. Review them against how you actually operate the app, including any authorized AI services and public hosting/tunnel provider. They do not make a personal installation a public service or establish TikTok approval. Do not enter a fictitious business name or an email address you do not control.

## 2. App description to copy

> Self-hosted AI connector for authorized TikTok accounts: video posting, publishing status, and owned-video metrics.

This describes the integration as implemented. Do not add comments, direct messages, advertising, automatic content creation, video editing, mobile sharing, or other capabilities that the TikTok integration does not provide.

## 3. Select only the products and scopes you demonstrate

| Product | Scope | How Connector uses it | What the recording must show |
| --- | --- | --- | --- |
| Login Kit for Web | `user.info.basic` | OAuth connects the consenting TikTok account; `/v2/user/info/` returns its account ID and display name for verification. Tokens stay on the Connector server. | Start from the real app, choose TikTok, complete TikTok's consent flow, return to the same app domain, and show the connected account identity. |
| Content Posting API — Direct Post | `video.publish` | Creator-info lookup obtains current posting restrictions. Connector submits a video from an HTTPS URL with `PULL_FROM_URL`, the chosen caption/privacy/interaction/disclosure settings, then checks publication status. | Show the selected creator, playable video preview, explicit posting choices, music/content consent, confirmation, actual submission, status check, and resulting video in the sandbox creator's TikTok account. |
| Display API | `video.list` | `/v2/video/query/` returns available views, likes, comment counts, and shares for a video owned by the connected creator. | Query a real supported video ID owned by the test creator and show the returned metrics. A successful empty result does not demonstrate the metrics feature. |

Do not select **Share Kit**, `video.upload`, `user.info.profile`, `user.info.stats`, research, business advertising, comment, or messaging permissions for this integration. `video.upload` is the inbox-upload flow and is different from the Direct Post flow implemented here. TikTok for Business is a separate connector and application setup.

For URL-based posting, TikTok fetches the video itself. Verify ownership of the video's domain or URL prefix in the Developer Portal. The video URL must directly serve the actual video file over HTTPS and meet TikTok's media requirements; a sharing-page URL is not equivalent. Website/domain verification and media-source verification are separate checks. If TikTok supplies an ownership-verification file or DNS record, publish it exactly as directed using a domain you control; the policy pages do not create that verification automatically.

## 4. Product and scope explanation to copy

Use this for an **initial submission** after your real sandbox flow works:

> Connector is a self-hosted web application used by its owner to connect authorized accounts to an AI assistant and perform explicit account actions. TikTok access is granted by the account holder through Login Kit for Web. We request user.info.basic to read the authorized account's ID and display name, verify the connection, and identify the account used by the integration.
>
> Content Posting API, with video.publish, is used for Direct Post of videos selected by the owner. Before a submission, Connector requests the creator's current posting options. The owner reviews the video, caption, privacy, comment/duet/stitch choices, and applicable commercial-content and AI-content disclosures, agrees to the required TikTok terms, and explicitly confirms the submission. The server validates the current creator restrictions and submits the video using PULL_FROM_URL from a TikTok-verified media source. Connector checks the returned publish ID to display processing, completion, or failure; acceptance is not presented as proof that a video is public.
>
> Display API, with video.list, is used to query available view, like, comment-count, and share counts for a video owned by the authorized creator. It does not provide a comments or direct-message inbox. Connector does not use Share Kit, the inbox-upload/video.upload flow, or TikTok advertising permissions for this integration.
>
> This is an initial application review. The demonstration uses the TikTok Developer Portal sandbox, an authorized test user, and the same public Connector website domain listed in this application. No prior production approval is claimed.

If this is actually a **revision**, replace the final paragraph with a truthful change summary. For this code update, you can describe the changes that you actually deployed and demonstrate:

> This revision adds public app-information, Terms of Service, and Privacy Policy pages; an app icon and app-review preparation panel; and a TikTok posting demonstration interface. The requested permissions remain user.info.basic, video.publish, and video.list. The attached recording demonstrates the revised deployed interface and the products and scopes requested in this application.

Do not say “initial application” for a previously approved application, or say “revision” simply because you updated your local Connector software. Do not claim that TikTok has approved Connector, that all posts can be public, or that a sandbox recording proves production eligibility.

## 5. Prepare a real sandbox demonstration

The submission needs evidence of a real integration. Automated browser tests, fixture data, screenshots, an AI-generated video, or a recording of only the setup instructions are not a substitute for TikTok authorization and API results. No TikTok sandbox credentials or live account authorization are included with Connector.

1. Sign in to [TikTok for Developers](https://developers.tiktok.com/) and open your application in the Developer Portal.
2. For an app that has not been approved, choose its **Sandbox** environment. Add the TikTok account you will use as a sandbox test user, following the portal's test-user authorization flow.
3. Enable the three products and three scopes in section 3 only if they are available to your sandbox and match the actual features you intend to request. Record any eligibility limitation honestly; do not replace it with fabricated successful responses.
4. Register the exact HTTPS callback shown in Connector's TikTok setup. Confirm the website and legal URLs use the same domain you will record.
5. Copy your sandbox client key and client secret into Connector's TikTok setup and save. Do this before recording; keep secrets, ngrok tokens, AI connector keys, passwords, and other accounts out of the recording.
6. Prepare a short video you own or are authorized to publish. Host it as a direct HTTPS video URL on a domain or URL prefix verified for the TikTok app. Confirm it plays in the browser. Use non-branded test content for a private-only sandbox post: TikTok does not allow branded-content disclosure with `SELF_ONLY` privacy.
7. Have a supported **existing public video owned by that same test creator** available for the Display API metrics demonstration, and note its numeric video ID. An unaudited private test post may not be retrievable through Display API, so do not assume its ID will demonstrate `video.list`.
8. Rehearse the flow once. Confirm the connection succeeds, the creator settings load, the video preview works, publication can complete within sandbox restrictions, and owned-video metrics return actual data. Keep failed API results visible and resolve them before recording a submission.
9. Start the final recording from the public Connector website with its browser address bar visible. If necessary, disconnect the local TikTok connection first so the recording can show the real Connect flow. Disconnecting in Connector removes its locally saved credential; it does not promise remote token revocation. To demonstrate a fresh TikTok consent grant, remove the app's permission in TikTok account settings and reconnect. Rehearse that step before recording.

## 6. Record the complete flow on Windows

On Windows 11, you can use Snipping Tool without terminal commands:

1. Close unrelated apps and private browser tabs. Turn off desktop notification previews for the recording.
2. Open **Start**, type **Snipping Tool**, and open it.
3. Select the **Record** / video-camera mode, then **New**. If your installed Snipping Tool has no recording mode, update it from Microsoft Store or use a screen recorder such as [OBS Studio](https://obsproject.com/).
4. Select the browser window area including the address bar and the whole app interface. Choose **Start**. Record the actual mouse clicks and visible results below. Pause or obscure private credentials if needed, while keeping the OAuth redirect and account-consent steps understandable.
5. Show the public Connector app and its app-information, Terms, and Privacy links. Return to the dashboard.
6. Choose TikTok in **Connections**, click **Connect account**, and complete the real TikTok sandbox test-user authorization. Show the requested permission names and the return to your registered Connector domain. Show the connected account's identity.
7. In **Connections**, find TikTok and click **TikTok publishing**. Current creator options load when you open the connected account; click **Refresh publishing options** if needed. Show the creator identity, allowed privacy choices, maximum video duration, and interaction restrictions.
8. Enter the real verified-source video URL, click **Preview video**, play the preview, and enter a caption. Wait for its duration to load; a failed or over-limit preview must be resolved before proceeding. Choose privacy explicitly from the options TikTok returned. Choose comments, duet, and stitch only where allowed. Show the commercial-content and AI-content settings, and the linked TikTok terms/consent. For the non-branded sandbox example, choose no commercial-content disclosures and use `SELF_ONLY` if the unaudited app is restricted to private posting.
9. Click **Review video**, show the final review, and click **Publish to TikTok** once to confirm. Show the returned publish ID, click **Check publication status**, and wait until TikTok reports completion or explain any genuine error. Do not label a submitted/processing response as a completed publication.
10. Open the test creator's TikTok account and show the resulting video. A private sandbox video is valid evidence of that actual test; do not imply it was publicly published.
11. Return to **TikTok publishing**. Enter the existing public owned-video ID prepared earlier and click **Read video metrics**. Show the real view/like/comment/share results. This is the demonstration of Display API and `video.list` even when the newly submitted sandbox video is private.
12. If your review explanation says actions also come from an AI assistant, briefly show a connected AI app using Connector to read the TikTok creator options or owned-video metrics and returning the real tool result. Keep the Connector domain visible in the preceding app flow. Do not show an unrelated chatbot answer as evidence of a tool call.
13. In Snipping Tool, choose **Stop**, then **Save as**. Save the recording as an **MP4** in a folder you can find, for example **Videos → Connector TikTok review.mp4**.
14. Play the saved file from beginning to end. Confirm the text is readable, every selected product/scope is demonstrated, the domain matches the application, no credentials are exposed, and the actual submission/result is visible.
15. In File Explorer, right-click the file and choose **Properties**. Verify the size is **under 50 MB**. MP4 and MOV are accepted; upload **no more than five files**, each within the limit. If too large, record a shorter focused demo or export at 720p using a video editor, then recheck readability and file size. Renaming a different file extension to `.mp4` does not convert it.
16. Use Connector's review panel to check the chosen local file names, formats, sizes, and count, then upload the actual file(s) in the **TikTok Developer Portal**. Connector's file check is local; it does not upload a video to TikTok or verify that the recording demonstrates the required flow.

One focused recording is easiest to review. If splitting across files, keep the sequence clear and cover every product/scope across the submitted files. TikTok permits at most five files of up to 50 MB each. Do not upload a mock walkthrough as if it were a completed live sandbox test.

## Implementation and review limits

- The public pages are available while this installation and its public address are online. A PC that is asleep or disconnected cannot serve them to a reviewer.
- TikTok's sandbox, approval, account eligibility, media requirements, and rate limits apply independently of Connector.
- Scheduled submissions and authorized AI tools use the same server-side TikTok action adapter. They are not a substitute for demonstrating TikTok's required user-facing posting experience. Only describe and record flows that are eligible and actually implemented.
- Disconnecting in Connector removes its saved TikTok credentials and profile. It does not delete already published TikTok content or erase prior action/schedule records. Remove the app's access in TikTok as well when revoking the platform authorization.
- Live sandbox recording requires the operator's TikTok developer app, test account, verified media source, authorization, and actual interaction. The automated test suite does not establish production approval or a successful live TikTok post.

## Official references

- [TikTok app review guidelines](https://developers.tiktok.com/doc/app-review-guidelines)
- [Login Kit for Web](https://developers.tiktok.com/doc/login-kit-web)
- [Scopes](https://developers.tiktok.com/doc/tiktok-api-scopes)
- [Content Posting guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)
- [Direct Post API](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)
- [Creator information](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info)
- [Publication status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status)
- [Video query](https://developers.tiktok.com/doc/tiktok-api-v2-video-query)

Developer Portal labels and requirements can change. Follow the current instructions in your portal. The build environment could not retrieve TikTok's documentation host because its network proxy denied that host; the implementation was audited against the repository's official endpoint definitions and the review requirements supplied for this task, not a live approval decision.
