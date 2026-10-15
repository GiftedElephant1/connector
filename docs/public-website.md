# Publish Connector's public website

Connector includes a separate, public information website for **Vectre Pay Inc**. Its intended address is **https://connector.vectrepay.com/**. It describes Connector, links to its Privacy Policy and Terms, and gives **contact@vectrepay.com** as the public contact. Visitors and Google reviewers can read these pages without signing in or keeping your PC running.

**Hosting is free:** this public repository can use GitHub Pages with a custom domain and HTTPS on GitHub's free plan. GoDaddy continues managing the domain and DNS; you do not need GoDaddy hosting, Website Builder, or a separate SSL purchase. Existing domain registration/renewal remains separate. These instructions do not start a paid hosting service.

The website is ready to build. A prepared build is not proof that the domain is live: GitHub Pages, DNS, HTTPS, and Google ownership verification must be completed and checked below. Google makes the final verification decision.

## What stays on your PC

This website contains public HTML, CSS, and the app icon only. It has no login, account database, API endpoints, OAuth callback handler, tracking scripts, or account credentials. Your Connector workspace continues running separately, with its saved accounts and schedules. Publishing this website does not change the workspace address or disconnect any accounts.

Use the website for Google Auth Platform's **Application home page**, **Privacy policy**, and **Terms of service** fields. Do not use it as an OAuth redirect URI or an AI connector URL: a static website cannot receive the private app's callbacks or run tools.

## 1. Turn on GitHub Pages

1. Sign in to the GitHub account that owns [GiftedElephant1/connector](https://github.com/GiftedElephant1/connector).
2. Open the repository's **Settings** tab. If tabs are hidden, open the overflow menu.
3. In the left menu, click **Pages** under **Code and automation**.
4. Under **Build and deployment → Source**, select **GitHub Actions**.
5. Open the repository's **Actions** tab. Select **Publish public website** on the left.
6. Click **Run workflow**, select branch **main**, and click the green **Run workflow** button.
7. Open that run and wait for both **build** and **deploy** to succeed. The deployment link should show the actual Pages address. Before setting a custom domain, the default project address is normally `https://giftedelephant1.github.io/connector/`.
8. Open the deployment link in a private/incognito window. Confirm the homepage loads without a password, its Privacy and Terms links work, and the app icon appears.

If the workflow is not listed, the website changes have not reached the selected branch yet. If `configure-pages` says Pages is not enabled, repeat steps 2–4 before retrying. The workflow is manual so an ordinary app update does not unexpectedly publish a website or fail before hosting is configured.

## 2. Connect the owned domain

Only change the **connector** subdomain. Keep the existing website at `vectrepay.com` and the business's email/DNS records in place.

1. Open GitHub **profile picture → Settings → Pages**. This is your personal account's settings, not the repository's settings.
2. Under **Verified domains**, choose **Add a domain** and enter `connector.vectrepay.com`.
3. GitHub provides a TXT record name and value. Keep that page open, then open [GoDaddy My Products](https://account.godaddy.com/products) in another tab and sign in. Under **Domains**, find **vectrepay.com** and choose **DNS** or **Manage DNS**. In **DNS Records**, click **Add New Record** and choose **TXT**.
   - In **Name**, enter the record prefix GitHub supplies, omitting the final `.vectrepay.com` because GoDaddy adds it. For example, a full name of `_github-pages-challenge-GiftedElephant1.connector.vectrepay.com` uses `_github-pages-challenge-GiftedElephant1.connector` in GoDaddy's Name field. Use GitHub's actual name if it differs.
   - In **Value**, paste GitHub's complete verification value. Leave **TTL** at its default and click **Save**. Do not replace existing TXT records.
4. Return to GitHub and click **Verify**. Keep that TXT record after verification. DNS changes may take time to become visible.
5. Open **connector repository → Settings → Pages**. Under **Custom domain**, enter `connector.vectrepay.com` and click **Save**. Configure this on GitHub before pointing DNS at it.
6. Return to **GoDaddy → My Products → Domains → vectrepay.com → DNS / Manage DNS → DNS Records**. Click **Add New Record**, choose **CNAME**, and enter:

   | Field | Value |
   | --- | --- |
   | Type | `CNAME` |
   | Name / Host | `connector` |
   | Target / Value | `giftedelephant1.github.io` |
   | TTL | Default or automatic |

   Click **Save**. GoDaddy's Name field should contain only `connector`; it appends `.vectrepay.com` itself. Do not include `https://`, `/connector`, or a trailing path in the target. If this hostname already has a record serving another application, check what uses it before replacing anything. A CNAME cannot coexist with other record types at that exact hostname. The GitHub verification TXT record has a different hostname.

   If GoDaddy says DNS is managed elsewhere or its record controls are unavailable, its nameservers point to a different DNS service. These changes must be made at that service; do not change nameservers just to add this website.
7. Return to the repository's **Settings → Pages** and wait for the DNS check and TLS certificate to be ready. Enable **Enforce HTTPS** when it becomes available. DNS and certificate provisioning are not instant.
8. Run **Actions → Publish public website → Run workflow** again. It reads the configured custom domain from GitHub Pages and builds matching links. For a Pages Actions deployment, GitHub's repository setting controls the custom domain; a generated `CNAME` file alone does not configure hosting.
9. In an incognito window, verify these exact addresses load without a login, warning, or tunnel interstitial:

   - `https://connector.vectrepay.com/`
   - `https://connector.vectrepay.com/privacy/`
   - `https://connector.vectrepay.com/terms/`

GitHub Pages hosts these pages independently of the Windows app. Turning off the PC must not make these three pages disappear.

## 3. Verify the domain with Google

GitHub verification and Google's domain ownership verification are separate checks.

1. Sign in to [Google Search Console](https://search.google.com/search-console/) with the Google account that owns or edits the Cloud project used by Connector. For this business, use `aj.denham@vectrepay.com` if it has that project role.
2. Open the property selector and click **Add property**.
3. Choose **Domain**, enter `vectrepay.com` without `https://` or a path, and click **Continue**.
4. Copy Google's provided DNS TXT value, then open **GoDaddy → My Products → Domains → vectrepay.com → DNS / Manage DNS → DNS Records → Add New Record**. Select **TXT**, enter **`@`** in **Name**, and paste the entire Google value into **Value**. Leave **TTL** at its default and click **Save**. Here `@` means the root `vectrepay.com`; it is different from the GitHub verification prefix in the previous section. Keep all existing records, including mail records and other verification TXT values.
5. Return to Search Console and click **Verify**. Keep the verification record after it succeeds. An existing verified Domain property can be reused; it covers subdomains. The Google account submitting the OAuth verification must have the required verified-owner relationship and Cloud project access.
6. Open [Google Cloud Console](https://console.cloud.google.com/), select the **same project as Connector's OAuth client**, then open **Google Auth Platform → Branding**.
7. Use these public values:

   | Field | Value |
   | --- | --- |
   | App name | `Connector` |
   | User support email | An eligible business email you control and monitor, as offered by Google's dropdown |
   | Application home page | `https://connector.vectrepay.com/` |
   | Application privacy policy | `https://connector.vectrepay.com/privacy/` |
   | Application terms of service | `https://connector.vectrepay.com/terms/` |
   | Authorized domain | `vectrepay.com` |
   | Developer contact email | `contact@vectrepay.com`, if this inbox is monitored |

8. Save, then review Google's **Verification Center** and resolve the specific listed findings. Use the same app name/logo in the consent screen and public website. Do not claim Google has verified the app until Google confirms it.

The homepage is public and describes the actual app; it is not the Vectre Pay corporate site or the workspace sign-in screen. The policy applies to Connector and explains its Google/YouTube data use, retention, user controls, and authorized AI access. Review it for accuracy before submitting it. A public policy or checkbox does not replace the technical and operational requirements of Google's policies.

## 4. Keep Google login and callbacks correct

Branding, account access, and permission verification are different checks:

- **`redirect_uri_mismatch`:** register the exact callback shown in Connector with the matching **Web application** OAuth client. Keep existing valid callback entries. The public website's `/privacy/` address is not a callback.
- **`org_internal`:** an Internal app blocks identities outside its Google Workspace organization. External mode may be needed for a personal Google identity or YouTube Brand Account. During Testing, add the actual signing-in Google account as a test user.
- **Testing expiry:** refresh tokens for External apps requesting these Google service scopes generally expire after seven days in Testing. Production status and any required verification are separate from simply publishing this website.
- **Sensitive/restricted scopes:** Google may require scope justification, a real demonstration, and additional assessment for certain uses. Submit only the features and scopes you actually need. This static website does not grant API access, approve scopes, change Ads API eligibility, or complete a YouTube API audit.

If Google also flags the **ngrok callback domain** as unverified or invalid, the new website alone cannot fix that. The currently assigned `ngrok-free.dev` hostname is separate from your owned `vectrepay.com` domain. Do not claim ownership of a domain controlled by the tunnel provider.

For that case, reserve a different owned hostname for the **live workspace**, such as `app.vectrepay.com`, after confirming it is unused. Connector's current ngrok integration already accepts an assigned domain: reserve the custom hostname in your ngrok account, follow ngrok's required plan and DNS setup, and then enter it in **Settings → Make Connector available to your AI agent → Use an assigned ngrok domain**. Domain registration, DNS control, and any hosting/tunnel charges are external prerequisites, not features a code update can silently provide.

Before switching the live workspace address:

1. Keep the existing installation, encryption configuration, and database. Do not use **Disable and reset**.
2. Check the new HTTPS hostname reaches the running Connector backend; do not point it at GitHub Pages.
3. Add the new callback URLs for every affected provider before starting new authorizations. Keep the old entries during migration. Google Workspace's callback is separate from the individual YouTube/Ads/Analytics/Search Console callbacks; copy each from its setup screen.
4. Stop the old public tunnel, select the newly assigned domain, start public access, and open/sign in to the new public workspace.
5. Update the public API/MCP address in AI clients. Browser sessions and some AI OAuth grants may need a new sign-in; changing a hostname does not require deleting platform credentials.

The exact domain migration should be carried out once the hostname and DNS/tunnel settings are ready. Publishing the information site does not perform this migration.

## Maintaining the site

Public identity and canonical domain settings live in `client/public-profile.json`. The public page renderer is shared with the app, so changes to policy text can appear in both deployments. The static build does not read the private installation's settings: if you change the operator/contact in the desktop app, update this public profile and publish again too.

Maintainers can run:

```sh
npm ci
npm run build:public-site
```

The output is **only** `artifacts/public-site/`. Never publish the repository root, `.env`, `data/`, or the private app's `dist/` as this website.

For a project-URL preview, set `SITE_URL=https://giftedelephant1.github.io/connector` before running the build. The builder prefixes links/assets and omits the production `CNAME` for that preview. Project path segments accept letters, numbers, hyphens, and underscores; dotted project paths are not supported. `PUBLIC_SITE_CUSTOM_DOMAIN` can explicitly set or clear the custom-domain file; if set, it must match an owned root `SITE_URL`. Invalid URLs, paths, or mismatched custom domains fail the build.

Ordinary code pushes do not publish this site. After reviewing a website or policy change, use **Actions → Publish public website → Run workflow** to deploy it.

Official references: [GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site), [GitHub domain verification](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages), [Google Search Console ownership verification](https://support.google.com/webmasters/answer/9008080), [Google OAuth app verification](https://support.google.com/cloud/answer/9110914).
