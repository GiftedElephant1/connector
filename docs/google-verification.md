# Google branding, domain ownership, and account access

Connector’s public app website is prepared for **https://connector.vectrepay.com/**. Its public name is **Connector**, its operator is **Vectre Pay Inc**, and its contact address is **contact@vectrepay.com**. These values come from [`client/public-profile.json`](../client/public-profile.json).

The files in this repository prepare the website and instructions. They do not establish that DNS, HTTPS, Google domain ownership, or an OAuth review has been completed. Check those services before resubmitting.

## What fixes each reported issue

| Google’s finding | Required correction |
| --- | --- |
| The homepage lacks a privacy link | Use the Connector public homepage, which visibly links to its privacy policy. |
| The ngrok privacy domain is not valid | Publish the policy on `connector.vectrepay.com` and verify ownership of `vectrepay.com`. |
| The homepage is behind login | Submit the public static homepage, not the private Connector dashboard. Test it while signed out. |
| The homepage does not explain the app | Submit the app-specific page describing account connections, permitted actions, Google data use, and user control. |
| `redirect_uri_mismatch` | Register the running workspace’s exact callback in the correct Google OAuth web client. Branding changes do not register callbacks. |
| `403: org_internal` | Use an External audience when the authorized Google identity is outside the Workspace organization, including affected YouTube Brand Account flows. |

## 1. Publish the website with GitHub Pages and GoDaddy

The static website must remain available when the PC running Connector is off. GitHub Pages serves these public pages; it does not host the Connector API, account tokens, or private dashboard.

GitHub Pages hosting and HTTPS are free for this public repository. Keep the existing domain and DNS at GoDaddy; no GoDaddy website hosting plan or paid SSL certificate is required.

1. Open the [Connector repository](https://github.com/GiftedElephant1/connector). Open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**. Open **Actions → Publish public website → Run workflow**. Select **main**, and run it. Wait for both build and deploy to succeed, then check the deployment link.
3. Follow the [public website publishing guide](public-website.md#2-connect-the-owned-domain) to verify the domain in your GitHub account. Then set the repository’s Pages **Custom domain** to `connector.vectrepay.com` and save.
4. Sign in to [GoDaddy](https://www.godaddy.com/). Open **My Products → Domains → vectrepay.com → DNS**. Depending on its layout, the action may be called **Manage DNS**.
5. Inspect records with the name `connector`. A CNAME cannot coexist with an A, AAAA, or another CNAME at that same name. If an existing record serves something important, arrange its replacement deliberately; do not delete root, email, or unrelated records.
6. Click **Add new record** and enter:

   | Field | Value |
   | --- | --- |
   | Type | `CNAME` |
   | Name / Host | `connector` |
   | Value / Points to | `GiftedElephant1.github.io` |
   | TTL | Leave GoDaddy’s default |

   Use only the hostname in the value: no `https://`, repository name, or path. Save the record. Do not change nameservers or forward the subdomain to a login page.
7. Return to GitHub **Settings → Pages**. Allow DNS propagation and GitHub certificate provisioning to finish. Enable **Enforce HTTPS** when available.
8. Run **Actions → Publish public website → Run workflow** again to build matching custom-domain links. In an incognito window, open all three pages below. Confirm the correct app information appears without signing in, and that the homepage’s privacy and terms links work:
   - `https://connector.vectrepay.com/`
   - `https://connector.vectrepay.com/privacy/`
   - `https://connector.vectrepay.com/terms/`

Keep the primary `vectrepay.com` website and email records unchanged. Only the new `connector` hostname points to Pages. A CNAME containing the repository path, such as `GiftedElephant1.github.io/connector`, is invalid.

## 2. Verify the business domain with Google

1. Sign in to [Google Search Console](https://search.google.com/search-console) with an account that is an **Owner or Editor** of the Google Cloud project containing Connector’s OAuth client. The domain must be verified by an appropriate project owner/editor, not only by an unrelated Google account.
2. Open the property selector and choose **Add property**.
3. Choose **Domain** and enter `vectrepay.com`, without `https://` or a path.
4. Follow the verification method Google offers. If it provides a DNS TXT value, copy the full value beginning with `google-site-verification=`.
5. In GoDaddy’s DNS screen, add a **TXT** record. Use **Name / Host: `@`**, paste Google’s exact verification value, leave the default TTL, and save. Add a separate record; do not replace existing SPF, DKIM, DMARC, or other TXT records.
6. Return to Search Console and click **Verify**. If DNS has not propagated, retry after propagation. Keep the record after successful verification.

## 3. Correct Google OAuth branding

1. Open [Google Cloud Console](https://console.cloud.google.com/), select the project already used by Connector, and open **Google Auth Platform → Branding**. The older interface calls this **APIs & Services → OAuth consent screen**.
2. Set or confirm these values:

   | Google field | Value |
   | --- | --- |
   | App name | `Connector` |
   | User support email | `contact@vectrepay.com`, once eligible in the dropdown |
   | Application home page | `https://connector.vectrepay.com/` |
   | Application privacy policy | `https://connector.vectrepay.com/privacy/` |
   | Application terms of service | `https://connector.vectrepay.com/terms/` |
   | Authorized domain | `vectrepay.com` |
   | Developer contact email | `contact@vectrepay.com` |

3. Google may restrict the support-email dropdown to eligible project users or Google Groups. Make the monitored support address eligible, or use an eligible monitored address you control. Merely typing an email in a contact field does not create a mailbox or grant account access.
4. If using the Connector logo, upload the public app logo from the website/repository and keep its name consistent with the homepage. Do not claim Google approval on the site or in the logo.
5. Save the changes. Recheck the published pages while signed out before submitting review.

## 4. Set the audience and declare permissions

1. Open **Google Auth Platform → Audience**.
2. Use **External** when connecting personal Gmail accounts or identities outside the Cloud project’s Google Workspace organization. A YouTube Brand Account may be treated as an outside identity even when the channel’s display name is your company name; `org_internal` is an audience restriction, not a callback typo.
3. While the app is in **Testing**, add the actual Google sign-in email of each person who will authorize access under **Test users**. Include the account that owns or can manage the intended YouTube channel. A channel display name is not a Google email address.
4. Open **Data Access** and declare the scopes actually used by the connectors you intend to connect. Only enable features you intend to use; do not add speculative permissions for future features.
5. Enable each relevant API under **APIs & Services → Library**. YouTube uses the YouTube Data API v3 and YouTube Analytics API; other Google and Workspace connectors need their corresponding APIs and service access.
6. For continuing use, move to **Production** when the setup is ready and complete Google’s required reviews. External Testing refresh tokens for these integrations generally expire after seven days. Production status does not automatically grant sensitive or restricted scopes, lift all limits, or guarantee approval.

Branding verification, sensitive/restricted scope verification, any required security assessment, Google Ads API access, and YouTube API compliance checks are separate requirements. Google determines which apply. Passing branding does not guarantee the rest are approved. Do not submit a fictional demo or claim an untested capability.

## 5. Preserve the real OAuth callbacks

The public website and the running Connector workspace have different jobs:

| Address | Purpose |
| --- | --- |
| `https://connector.vectrepay.com/` | Public app description and legal pages on GitHub Pages |
| The public HTTPS workspace address shown in Connector Settings | Authenticated dashboard, OAuth callbacks, and AI tool access on the running Connector server |

**Do not set Connector’s public workspace address to the static Pages website.** Pages cannot handle `/api/oauth/...`, `/api/workspace/...`, or `/mcp` requests.

1. In Connector, open **Settings → Platform application settings → [Google connector] → Manage setup**. The Google guide displays the callbacks derived from the running workspace’s current address. Workspace also shows the guide under **Google Workspace → Manage Google setup**.
2. Open **Google Auth Platform → Clients** in the same project. Select the **Web application** client whose ID matches the Google client ID saved in Connector.
3. Add each relevant callback under **Authorized redirect URIs**. Keep existing entries:

   | Connector | Path appended to the running workspace’s HTTPS origin |
   | --- | --- |
   | YouTube | `/api/oauth/youtube/callback` |
   | Google Ads | `/api/oauth/google-ads/callback` |
   | Google Analytics | `/api/oauth/google-analytics/callback` |
   | Google Search Console | `/api/oauth/search-console/callback` |
   | Google Workspace | `/api/workspace/google/callback` |

4. Save. Keep the existing client ID and client secret in Connector. You do not need to reset every account or create another OAuth client just to correct branding or add a callback.
5. If Google reports `redirect_uri_mismatch`, compare the URI in Google’s **error details** with the saved entry for this exact client. Match the scheme, hostname, path, and trailing slash exactly. Allow time for saved changes to apply and start a fresh **Connect account** attempt.

If Google requires ownership verification of the runtime callback domain, a shared ngrok hostname may still block production review. Use a **separate owned HTTPS runtime hostname** backed by the running Connector server, with a valid certificate and public reachability. This is additional hosting/tunnel configuration; the static website alone does not supply it. Then update Connector’s public workspace address and register its new callbacks for each provider before reconnecting. Do not replace the static Pages CNAME with a private or nonfunctional server merely to pass a form.

## 6. Resubmit the corrections

Open Google Auth Platform’s **Verification Center**, or the review/resubmit prompt shown under Branding. Check that the submitted homepage, privacy URL, terms URL, app name, support address, verified domain, audience, and scopes refer to the same app and project. Submit the corrections and respond to any follow-up Google requests. Approval and timing are controlled by Google.

The software changes preserve local accounts, saved credentials, and schedules. Public site deployment cannot alter the Google project, accept an invitation, verify DNS, or approve the app by itself.

Official references:

- [Google homepage requirements](https://support.google.com/cloud/answer/13807376)
- [Google privacy policy requirements](https://support.google.com/cloud/answer/13806988)
- [Google web-server OAuth errors](https://developers.google.com/identity/protocols/oauth2/web-server#authorization-errors-redirect-uri-mismatch)
- [Search Console ownership verification](https://support.google.com/webmasters/answer/9008080)
- [GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)
