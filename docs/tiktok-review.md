# Prepare Connector for TikTok app review

Connector includes public app-information, Terms of Service, and Privacy Policy pages, an original app icon, and a **TikTok app review** setup panel. These help you prepare your submission. TikTok still decides whether your actual app, intended use, selected products, and recording meet its review requirements.

**Check the intended-use requirements before submitting Direct Post.** Connector is a self-hosted, personal AI-to-account pipeline. TikTok's Content Posting guidelines exclude internal utilities that upload to accounts managed by the developer or their team. That limitation is relevant to this use: adding policy pages or a recording does not change it. Describe the real personal use honestly; do not claim a public creator service or an existing approval. Sandbox testing is not production approval. If TikTok will not approve this use, remove Content Posting API / `video.publish` from the application and do not represent TikTok publishing as available. The connector's requested scopes must also be adjusted before connecting a reduced-scope application.

## 1. Create the developer account and connect TikTok

Work through this section in order. Keep two browser tabs open: your public **Connector** workspace and **TikTok for Developers**. A TikTok developer account registers your own integration; it is separate from an Anthropic, OpenAI, or xAI developer account. This process does not require any of those AI developer accounts or keys.

### A. Prepare your public Connector pages

1. Start Connector from your existing installation and sign in.
2. Open **Settings**. Under **Make Connector available to your AI agent**, start public access if it is not already running.
3. Click **Open public workspace**. Sign in at that HTTPS address. Keep the PC awake, Connector running, and the tunnel available during review.
4. In **Settings**, find **TikTok app review**, then click **Prepare TikTok submission**. This distribution is configured for **Vectre Pay Inc**, with **contact@vectrepay.com** as the public contact email. Review these details and the policy pages; if you change them, click **Save public page details**. Previously saved operator details take precedence. These contact details are visible to anyone who opens the policy pages. An incomplete saved profile shows a setup-incomplete notice; do not submit unfinished pages.
5. Copy the generated public URLs from that panel. Use the URLs from your own running app, not a GitHub source-file URL or localhost address. The table below uses the public address you supplied; if the app now shows a different public address, use the current values from the app instead.
6. Open each URL in a signed-out/incognito browser window. Confirm it loads without a Connector password and shows the correct operator and contact details. An ngrok browser interstitial or offline tunnel can interfere with review; check what a new visitor actually sees.
7. Keep the same public domain throughout the application and recording. If the public address changes, update the website, policy URLs, Login Kit redirect URL, and any verified-domain configuration in TikTok's Developer Portal before submitting.

| TikTok application field | Value to copy from Connector |
| --- | --- |
| App name | `Connector` |
| Website URL | `https://speak-moonwalk-granola.ngrok-free.dev/about` |
| Terms of Service URL | `https://speak-moonwalk-granola.ngrok-free.dev/terms` |
| Privacy Policy URL | `https://speak-moonwalk-granola.ngrok-free.dev/privacy` |
| Login Kit redirect URI | `https://speak-moonwalk-granola.ngrok-free.dev/api/oauth/tiktok/callback` |
| App icon | Download the PNG using **TikTok app review** and upload that file |

The policy pages describe this installation's behavior. Review them against how you actually operate the app, including any authorized AI services and public hosting/tunnel provider. They do not make a personal installation a public service or establish TikTok approval. Do not enter a fictitious business name or an email address you do not control.

### B. Register your TikTok developer account

1. In the Connector review panel, click the link for [TikTok for Developers](https://developers.tiktok.com/), or open that exact address in a new browser tab. Use this portal for the social TikTok connector, not TikTok Ads Manager or the TikTok for Business API portal.
2. Click **Log in** in the portal. If you already have a TikTok developer account, sign in and continue to part C. If you do not, choose **Sign up** or **Register** on its sign-in screen. Portal labels and screen order can vary; follow the registration flow shown there.
3. Enter an email address whose inbox you can access. You can use **contact@vectrepay.com** if you can receive messages there; the public contact address does not have to be the same as your private login address. Choose your own developer-account password if the form asks for one. Do not enter these login credentials into Connector.
4. Complete any CAPTCHA or identity challenge. Click the portal's button to send a verification code or email.
5. Open that email inbox in another tab, find the TikTok verification message, and copy its code or follow its verification link. Check the spam/junk folder if it does not arrive. Return to the developer-registration tab, enter the code if requested, and complete verification. If the code expires, request a new one from the portal.
6. Read the developer terms and privacy notice. Accept them only if you agree, then finish registration using the portal's confirmation button.
7. Complete any requested developer profile. Enter your actual name and the true operator/company name **Vectre Pay Inc** where a company or organization name is requested. Use **contact@vectrepay.com** for the public app contact. Select individual or organization according to the real registration you are making; company details in this guide do not prove business verification.
8. If the portal asks for a country, address, company registration number, authorized representative, or verification documents, provide the real information for your account/company. None of those details have been supplied to Connector, and the app does not generate or submit them. Complete any verification that TikTok requires before continuing.
9. After signing in, open the portal's app dashboard, usually called **Manage apps**. Leave it open for the next steps.

### C. Create the web application

1. In **Manage apps**, choose **Create app** or the equivalent add-application button. If you already created the correct application, open that app instead of creating a duplicate.
2. Enter **Connector** as the application name. If the portal asks for an owner or organization, select the real developer account or **Vectre Pay Inc** organization you just configured.
3. Choose **Web** as the platform when that choice is presented. Connector runs on your Windows PC but its TikTok interface and OAuth callback are a website, not a native Windows or mobile Login Kit integration.
4. Return to the Connector tab. Open **Settings → TikTok app review → Prepare TikTok submission** if the panel is closed.
5. Click **Download app icon (PNG)**. In your browser's Downloads, locate **connector-icon.png**. Return to TikTok's app form, choose its icon-upload control, select that downloaded PNG, and wait for the preview/upload to finish.
6. Copy **App description** from Connector's review panel into TikTok's description field. The exact text is also in section 2 below. Describe this personal, self-hosted integration honestly.
7. Copy **TikTok website URL** into the website field: **https://speak-moonwalk-granola.ngrok-free.dev/about** while that remains the configured public address.
8. Copy **Terms of Service URL** into the terms field: **https://speak-moonwalk-granola.ngrok-free.dev/terms**.
9. Copy **Privacy Policy URL** into the privacy field: **https://speak-moonwalk-granola.ngrok-free.dev/privacy**.
10. If TikTok asks for an app contact email, enter **contact@vectrepay.com**. Complete any other required fields with real information. Do not invent a mobile app-store listing, mobile bundle/package ID, public customer base, approval history, or registration details.
11. Save/create the application using the portal's button. Saving a draft or creating a sandbox application is different from submitting the production app for review. Prepare the real sandbox recording before final review submission.

### D. Configure products, scopes, redirect, and website verification

1. Open the new application's product/configuration settings. Add **Login Kit**, **Display API**, and **Content Posting API** only. Under Content Posting, use **Direct Post**.
2. In Login Kit, select/configure **Web** if the product asks for a platform.
3. Return to Connector. In **Connections**, find the **TikTok** card and click **Connect account**. If the application credentials have not been configured, the **Set up TikTok** dialog opens. Find **Redirect address** and click its copy button. Keep this dialog open while finishing the portal settings.
4. In TikTok's Login Kit web settings, add that exact value to **Redirect URI** or **Redirect URL** and save. For your supplied public address, the full value is **https://speak-moonwalk-granola.ngrok-free.dev/api/oauth/tiktok/callback**. Include the full callback path; do not enter only the domain, `/about`, or `/mcp`. Do not add an extra trailing slash. If TikTok has separate sandbox and production settings, save the callback in the environment you are configuring.
5. In the product permissions/scopes settings, request **`user.info.basic`**, **`video.list`**, and **`video.publish`**. Product selection and scope selection may be separate steps in the portal. Save all changes. Section 3 maps each scope to the exact implemented feature.
6. Remove unused products/scopes from the review request. This integration does not use Share Kit, `video.upload`, comments, direct messages, or advertising permissions. If TikTok does not offer or approve a required scope for your app, that feature is not available; adding it to the explanation does not unlock it.
7. If the portal asks for a **web domain**, use **speak-moonwalk-granola.ngrok-free.dev** while it is your configured app domain. If a field explicitly requests a URL rather than a hostname, use the HTTPS URL it asks for. Follow the field's example; do not put the callback path into a domain-only field.
8. If TikTok asks you to **verify URL/domain ownership** with a text file, follow the complete in-app upload steps in part D1 below. Connector can serve that verification file at the root of its own public website. TikTok must still check and accept it; publishing the file is not itself proof that verification succeeded.
9. For a DNS verification option, sign in to the domain's registrar/DNS provider, open its DNS records, and add the exact record type, name/host, and value supplied by TikTok. Save, allow DNS changes to propagate, then return to TikTok and verify. You cannot add DNS records for ngrok's shared **ngrok-free.dev** parent domain. If TikTok requires a method unavailable for your assigned ngrok address, use a domain you control with hosting/tunnel configuration that supports that method, update Connector's public address and every URL above, and complete verification there. Do not claim the domain is verified before the portal confirms it.
10. If a product asks for the use-case explanation, copy the matching text from section 4 or the in-app review panel. Use initial-submission wording for an initial review; describe actual deployed changes if this is a revision.

### D1. Upload the website-verification file when TikTok asks for it

1. In TikTok's website/URL-ownership verification screen, choose its **file-upload** method if available and download the verification text file TikTok provides. Keep the original `tiktok….txt` filename and file contents; do not rename it to a friendly title or copy its text into a new document.
2. Return to Connector and open **Settings → TikTok app review → Prepare TikTok submission**. The same review panel is also available in the **Set up TikTok** dialog.
3. Under the public website/policy URLs, expand **TikTok asks me to upload a verification file**.
4. Find **TikTok website verification file** and click its file picker. In File Explorer, open **Downloads**, select the original verification `.txt` file, and click **Open**. This picker accepts the TikTok verification filename and a text file no larger than 16 KiB; it is separate from the MP4/MOV demo picker.
5. Click **Publish verification file** and wait for the saved result. Do not select your TikTok client secret, ngrok token, `.env` file, or a document with private information: a website-verification file is deliberately public.
6. Click **Preview verification file ↗**. Check that the new browser tab is on your configured public Connector domain and shows TikTok's original verification text. The path should end with the unchanged verification filename. You can also copy **TikTok verification file URL** and open it signed out/incognito.
7. Return to TikTok's verification screen. If it asks for the verification-file URL, paste the value from Connector; if it already specifies the exact expected URL, compare it with Connector's value. Click TikTok's **Verify** or check button and wait for TikTok to confirm success. Leave Connector running and public access on while it performs that check.
8. If verification fails, check the exact domain, expected filename/path, file contents, public accessibility, and any ngrok browser interstitial. Connector serves the file only on its own configured public website. If TikTok expects it on another website, publish it through that website's host instead. If the portal requires a different path or verification method that the app does not support, follow the hosting/DNS method in part D rather than claiming success.
9. Keep the file available while TikTok requires it. **Remove verification file** stops serving the saved file; do not remove it during pending verification or a review that still depends on it. Updating Connector keeps the saved verification configuration.

This verifies the Connector website only. It does not upload a source video, verify an unrelated video-hosting domain, or prove ownership of the shared ngrok parent domain. Use the media host's own verification method for the video source you plan to submit.

### E. Add a sandbox test user and copy the two application credentials

1. In the Developer Portal app, select its **Sandbox** environment. A previously unapproved app must use a sandbox to demonstrate the integration for review. Do not use a production credential in one field and a sandbox credential in the other.
2. In that sandbox's **Target users** / test-user section, choose **Add target user** or the equivalent add/invite control. Follow the method the portal offers to add your actual TikTok creator account. Depending on the portal, this may present an authorization link, invitation, or sign-in flow; use the displayed flow rather than inventing a test username.
3. Open the provided invitation/authorization flow as the TikTok account you intend to demonstrate. Check the username before accepting. Finish any consent or invitation acceptance it asks for, then return to the developer portal and confirm that account is listed as an authorized sandbox target/test user.
4. Make sure the three products/scopes and the exact web redirect are saved for this sandbox. If the portal requires a sandbox-specific configuration or save/apply action, complete it now.
5. Find the sandbox application's **Client key** and **Client secret** in its credentials/application details. If the secret is hidden, use the portal's reveal control and any required confirmation. These values come from your TikTok application; they are not your TikTok password, an ngrok token, an AI-provider key, or an advertising app credential.
6. Click the copy control beside **Client key**. Return to Connector's **Set up TikTok** dialog and paste it into **TikTok client key**.
7. Return to TikTok's portal, copy **Client secret**, return to Connector, and paste it into **TikTok client secret**. Paste only each value, without quotation marks, a command, or a label such as `client_secret=`.
8. Click **Save and continue** in Connector. The values are stored encrypted. If you opened setup through **Connect account**, Connector then starts TikTok authorization. If you opened it only to edit application settings, return to **Connections → TikTok → Connect account** after saving.
9. When TikTok opens, sign in as the same account authorized as a sandbox target user. Review the account identity and requested permissions, then approve the access you actually want to grant. If a permission needed for a feature is not granted, that feature cannot work.
10. Wait for TikTok to redirect to your public Connector domain. Sign in to your Connector workspace if needed and look for **Connected** on the TikTok card. Click **View connection** to inspect the returned account identity. The card's refresh/verify button runs a fresh account verification; it does not grant missing scopes.
11. Click **TikTok publishing**. Confirm it loads the correct creator identity and current posting options. If it shows an error, confirm the environment, target user, client key/secret pair, granted scopes, saved callback, and public address first. Do not reconnect every other platform: only the affected TikTok connection needs troubleshooting.
12. Keep the developer portal and Connector tabs available. Continue below to prepare the verified media source, record the full sandbox flow, and submit the application. Never include client secrets, passwords, or other connection credentials in the recording.

### F. Finish the review submission after the sandbox recording

1. Prepare and record the real integration using sections 5 and 6. The video's media-source verification is separate from website/redirect setup: TikTok must be allowed to retrieve the actual video URL you submit.
2. Open the application review/submission screen in the Developer Portal. Check the app name, icon, description, public website/policy URLs, products, and three requested scopes against the saved Connector values.
3. Paste the truthful product/scope explanation from section 4 and, when appropriate, the actual revision changes.
4. Upload at least one real demo video in **MP4** or **MOV** format. Upload no more than **five files**, and keep **each file within 50 MB**. Use the Connector review panel's local file check, then select those files in TikTok's own upload control. Wait for uploads to complete.
5. Play/check the uploaded preview if the portal offers it. Confirm the recording shows the same website domain, real TikTok consent, every selected product/scope, explicit posting choices, real publication status, and real owned-video metrics.
6. Read any final declarations and select the portal's submit-for-review action when the information is complete and accurate. Submission does not activate production permissions. Keep the public pages available and watch the portal/contact inbox for TikTok's response or requested changes.
7. If TikTok approves the requested production access, follow the portal's production activation/configuration steps. When it provides a different production key/secret, replace the pair in Connector's TikTok application setup, confirm the production redirect is registered, and reconnect TikTok to grant the approved production permissions. Existing connections to other platforms remain saved. The app's local version number is not a TikTok approval status.

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

For URL-based posting, TikTok fetches the video itself. Verify ownership of the video's domain or URL prefix in the Developer Portal. The video URL must directly serve the actual video file over HTTPS and meet TikTok's media requirements; a sharing-page URL is not equivalent. Website/domain verification and media-source verification are separate checks. For the Connector website, use the in-app verification-file uploader in section 1.D1 when TikTok offers that method. A media URL on another host must be verified separately through that host or its DNS provider; uploading the Connector website file does not verify an unrelated video source.

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
