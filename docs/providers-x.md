# Connect X (Twitter) from the app

Connector includes these instructions in **Connections → X (Twitter) → Connect account → Set up X step by step**. The guide displays copy buttons for your real callback, website, public policy URLs, operator details, and a suggested use-case description. It uses the installation's saved public HTTPS address, so you do not need a terminal or configuration-file edits.

X requires its own developer application and API access for this connector. An X Premium or Grok subscription does not replace that requirement. This setup does not create an xAI API account. The X advertising connector has separate access requirements.

## 1. Open your public Connector workspace

1. Start Connector and enter your Connector password.
2. Open **Settings**. Under **Make Connector available to your AI agent**, start public access. If it is already running, leave it running.
3. Click **Open public workspace**. Sign in at that HTTPS address using your Connector password. Keep the original local tab available if you need it.
4. In the public workspace, open **Connections**, find **X (Twitter)**, and click **Connect account**. Click **Set up X step by step**.
5. Keep Connector and public access running while you work. Use this public workspace to start authorization so X can return you to the same browser session.

## 2. Sign in to X or create an account

1. In another browser tab, open [X](https://x.com/).
2. If you already have the X account that should own the developer application, click **Sign in**, enter the requested login details, and complete any verification.
3. If you do not have an account, click **Create account**, enter your real details, complete the email or phone verification requested by X, choose a password, and finish creating your profile.
4. Confirm that you can receive account-verification messages at the email address or phone number associated with that X account.
5. If the developer portal asks for additional account verification or two-factor authentication, complete those prompts in X. Keep any recovery codes somewhere safe. Requirements depend on the account and the current portal; Connector cannot complete these identity checks for you.

## 3. Enroll in the X Developer Portal

1. Click **Open X Developer Portal** in Connector, or open [developer.x.com](https://developer.x.com/).
2. Sign in with the X account from step 2. Choose the portal's developer sign-up, get-started, or enrollment option when shown.
3. Complete the developer-profile fields. Use your actual personal name where a personal name is requested. For an organization/company field, your supplied operator is **Vectre Pay Inc**; your supplied public contact email is **contact@vectrepay.com**. The guide shows the currently saved values, which you can change in Connector's public-page settings if needed. Your X account's login email and the public contact email do not have to be the same field.
4. Describe what the application will do with X APIs and data. You can copy the suggestion below, but review it and adapt it to each question. Disclose the actual data flow to your authorized AI assistants. Do not describe the app as a public multi-user service or invent a use case to qualify for access.
5. Read X's developer agreement, automation rules, and other policies shown. Accept the agreements yourself only if you agree, then submit the form.
6. Complete any email confirmation, identity check, or application review X requests before proceeding.
7. Read the API access and pricing currently offered in your portal. Check that the access includes the endpoints you intend to use: profile lookup, post writing, recent-search replies, direct messages, and post metrics can have different entitlements, quotas, or billing requirements. Choose and pay for access only after reviewing X's current terms. Connector does not enroll you in a paid plan or guarantee free API access.

Suggested use-case description:

> I operate a private, single-owner Connector installation for Vectre Pay Inc. It connects the X account I own or am authorized to manage. I explicitly approve publishing or scheduling text posts, replying to posts and direct messages, and reading recent replies, messages, and available post metrics. Authorized AI assistants receive the tool results needed for these tasks. This is a personal account-management pipeline, not a public multi-user service. I will follow X's automation and developer rules and will not use it for spam or bulk unsolicited messages.

## 4. Create or select an application

1. Open the developer portal's application dashboard.
2. If the portal uses **Projects & Apps** and requires a project, choose **Create Project**, give it a recognizable name such as **Connector**, select the use case that matches your actual account-management use, and complete its description.
3. Choose **Create App** or the equivalent action. If you already created an app for this Connector installation, select it instead of creating another.
4. Use **Connector** as the application name, or choose another unique name if X says it is already taken.
5. For a description, use: **Private account-management pipeline for owner-approved X posts, replies, direct messages, and available post metrics through authorized AI assistants.** Complete the owner/contact fields with your real information, save, and open the app's **Settings**.

Portal labels change. If your portal creates an app directly without a project, use that flow; a separate project is only required when the portal asks for one.

## 5. Configure user authentication

1. In the app's **Settings**, find **User authentication settings** and click **Set up** or **Edit**.
2. Enable **OAuth 2.0** user authentication if an enable switch is shown.
3. For application type, select a confidential **Web App**, or **Web App, Automated App or Bot** if the portal groups those labels. Connector has a server and authenticates with a client secret. A native/public app type does not match this implementation.
4. If the portal shows **App permissions**, choose **Read and Write and Direct message**, or the equivalent permissions for posts and DMs. Read-only permission cannot support publishing. OAuth 2.0 scopes are also requested separately by Connector during account authorization.
5. Copy **X callback / redirect URL** from the guide into the portal's **Callback URI / Redirect URL** field. It must end in `/api/oauth/x/callback`, with the same public HTTPS domain and no extra trailing slash. The AI/MCP URL is a different endpoint and does not go in this field.
6. Copy **X website URL**, **X Terms of Service URL**, and **X Privacy Policy URL** into the matching portal fields when requested.
7. Open the website and policy URLs in a signed-out/incognito browser window to confirm they are reachable and show the correct public details. Keep Connector and the tunnel online; a saved URL alone does not host the pages. Check for any tunnel interstitial that could affect visitors.
8. Save the user-authentication settings in X.

The guide generates the URLs from your current installation. For the public address you supplied, they would be:

| Portal field | URL |
| --- | --- |
| Callback / redirect URL | `https://speak-moonwalk-granola.ngrok-free.dev/api/oauth/x/callback` |
| Website URL | `https://speak-moonwalk-granola.ngrok-free.dev/about` |
| Terms of Service URL | `https://speak-moonwalk-granola.ngrok-free.dev/terms` |
| Privacy Policy URL | `https://speak-moonwalk-granola.ngrok-free.dev/privacy` |

Use the guide's current generated values if your public address changes. It withholds these submission URLs while the configured address is local HTTP. If an ngrok domain changes, update X's callback, website, and legal URLs and save them before reconnecting.

Connector requests these exact OAuth 2.0 scopes on the authorization screen. Enable them if your portal offers a scope selector; some portal versions request them only through the OAuth authorization URL.

| Scope | What it enables in Connector |
| --- | --- |
| `tweet.read` | Read posts, recent conversation replies, and available post metrics. |
| `tweet.write` | Publish text posts and replies, including owner-confirmed posts scheduled in Connector. |
| `users.read` | Verify the authorized account and display its username. |
| `dm.read` | Read recent direct-message events available to the account. |
| `dm.write` | Send an explicitly approved one-to-one DM or reply to a permitted recipient. |
| `offline.access` | Renew the connection with a refresh token when X permits it. |

Changing an app-permission setting does not add new scopes to an already-issued account token. Reconnect the account after a permission change so X can ask for fresh consent.

## 6. Copy the two correct credentials

1. After saving user authentication, locate **OAuth 2.0 Client ID and Client Secret**. X may show them immediately, or under the app's **Keys and tokens**.
2. Click the copy control beside the OAuth 2.0 **Client ID**. Return to Connector, scroll below the X setup guide, click **X OAuth client ID**, and paste.
3. Return to X's app page. Generate or reveal the OAuth 2.0 **Client Secret** if necessary, and copy it. If X only shows it once, keep a copy in your password manager.
4. Return to Connector, click **X OAuth client secret**, and paste.
5. Confirm that you used the OAuth 2.0 credentials from the same app. **API Key**, **API Key Secret**, **Bearer Token**, and OAuth 1.0a access tokens are separate credentials and do not work in these two fields. Do not share any secret in chat or a screenshot.

## 7. Save and connect

1. Click **Save and continue** below the credential fields. Connector stores them encrypted. In the Connect account flow, it then opens X authorization.
2. If you opened the dialog solely to change application settings, saving may only close the dialog. Return to **Connections** and click **Connect account** on the X card.
3. On X's authorization page, check the displayed username. If it is not the account you want Connector to manage, switch accounts in X and restart authorization.
4. Review the permissions, then choose **Authorize app** or the portal's equivalent approval button.
5. Wait for X to return to the same public Connector domain. The X card should show a connected status and your **@username**. Connector makes an authenticated profile request before saving the connection.
6. Use the X card's **Verify connection** control to repeat that read-only account check. A successful verification does not publish a post or send a message.
7. Test a read action before publishing through your authorized AI assistant. For a real write, review the destination, content, and action before confirming. Keep Connector running for any scheduled posts.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Callback/redirect mismatch | Exact HTTPS scheme, domain, and `/api/oauth/x/callback` path. Remove any unintended trailing slash. Update X's saved URL after a public-domain change. |
| Invalid client / token exchange failure | Use a confidential web app and its OAuth 2.0 Client ID and Client Secret, not API keys or bearer tokens. Replace the saved secret if you regenerated it. |
| Enrollment or access denied | Finish X's developer verification/review. Review the current API access available to your account and the permissions requested. |
| Connected, but an action fails | Check access to that exact endpoint, current billing/credits, quota, rate limits, and account eligibility. Recent search and DM endpoints can have different limits. DM recipients must permit messages, and some owned-post metrics only cover recent eligible posts. |
| New permissions do not work | Disconnect and authorize X again after changing permissions/scopes. Existing tokens do not automatically gain new grants. |
| Flow expires or returns to a different session | Sign in to Connector at its public HTTPS address before starting Connect account. Keep the app and tunnel running, then restart the authorization flow. |
| A write times out | Check the saved attempt in Connector's schedule/activity view and on X before retrying. A timeout can occur after X accepted the action. |

Official references: [X Developer Portal](https://developer.x.com/), [OAuth 2.0 authorization code with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), [post creation](https://docs.x.com/x-api/posts/create-post), [direct messages](https://docs.x.com/x-api/direct-messages/introduction), and [post metrics](https://docs.x.com/x-api/fundamentals/metrics).

The guide matches Connector's implemented OAuth 2.0 client and scopes. The development environment could not retrieve X's portal/documentation host, so changing portal labels, enrollment requirements, pricing, and endpoint entitlements are explicitly left to the live portal. No developer registration, paid subscription, account authorization, post, or DM was performed while preparing these instructions.
