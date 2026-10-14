# Connect LinkedIn and fix authorization errors

## Check product permissions first

If LinkedIn displays **“Bummer, something went wrong”** and then redirects back, check your approved scopes as well as the redirect addresses. That message alone does not identify the cause. Connector's member connection requests `openid profile w_member_social`; all three must appear under your developer app's **Auth → OAuth 2.0 scopes**.

If your list includes `w_member_social` and `r_basicprofile` but lacks `openid` and `profile`, the sign-in permissions Connector needs have not been granted. `r_basicprofile` is a separate permission and cannot authorize Connector's OpenID Connect user-info request.

1. Open [LinkedIn developer apps](https://www.linkedin.com/developers/apps), select the same app whose Client ID is saved in Connector, and click **Products**.
2. Find **Sign In with LinkedIn using OpenID Connect**. Click **Request access** or the access button LinkedIn offers, and complete its prompts.
3. Wait for access to become active. Return to **Auth**, scroll to **OAuth 2.0 scopes**, and confirm both `openid` and `profile` are listed. Submitting a request is not the same as receiving access.
4. Confirm `w_member_social` is listed for posting. If it is already there, you do not need to request that permission again. Otherwise request **Share on LinkedIn** under Products.
5. In Connector, choose **Connections → LinkedIn → Check LinkedIn setup**. Keep **Approved LinkedIn member reading** set to **false** unless LinkedIn also lists the restricted `r_member_social` scope. Click **Save and continue** if you changed this setting.
6. Click **Connect account** on the LinkedIn card to start a fresh authorization. Use the public workspace and leave it signed in through the return from LinkedIn.

The setup guide shows **Permissions Connector will request**, including optional scopes you enable. Compare that exact list with LinkedIn's Auth tab. Keep **Approved LinkedIn conversion uploads** false on Campaign Manager until `rw_conversions` is granted; the base ads connection uses `r_ads rw_ads r_ads_reporting`.

If you exposed a client secret in a screenshot or message, generate a replacement in LinkedIn's **Auth** tab, paste it only into Connector's **LinkedIn client secret** field, click **Save and continue**, and revoke the exposed secret in LinkedIn. The two LinkedIn connectors share these saved app credentials. You do not need to reset other connectors or change correctly registered redirect URLs. A new secret does not add product permissions.

Connector now translates recognized LinkedIn OAuth callback errors into setup instructions after validating your browser session and authorization state. It never displays the provider's raw error description or credentials. If LinkedIn returns you without a callback error, the generic LinkedIn screen alone cannot establish the cause; use the scope checklist above. If asked to sign in to Connector again, sign in and read the returned message, then start a new connection.

LinkedIn's [official SDK setup example](https://github.com/linkedin-developers/linkedin-api-python-client#getting-started) confirms that `/v2/userinfo` requires `openid` and `profile` from its OpenID Connect sign-in product.

## Fix redirect registration

**“The redirect_uri does not match the registered value”** is an error from LinkedIn before account authorization. The callback Connector sends must be registered in the LinkedIn developer app identified by its saved Client ID. A website URL, product application, or saved client secret does not register this callback.

You can correct this in LinkedIn without reinstalling Connector or disconnecting your other accounts.

If you previously saved the wrong LinkedIn Client ID or secret, use **Connections → LinkedIn → Disable and reset**. Review the shared LinkedIn / Campaign Manager reset, confirm, then select **Set up again** to enter the correct app details. [Full reset instructions](reset-connectors.md) explain which settings and pending jobs are removed.

1. Keep Connector running with public access on. Open its public workspace and sign in.
2. In **Connections**, find **LinkedIn** or **LinkedIn Campaign Manager** and click **Check LinkedIn setup**. On older versions, open **Settings**, find that platform, and click **Manage setup**.
3. Keep Connector open. In another tab, open [LinkedIn developer apps](https://www.linkedin.com/developers/apps), sign in, and select the app you created for Connector.
4. Open **Auth**. Compare the app’s **Client ID** with the LinkedIn Client ID shown in Connector. Edit the app whose ID matches. If you intended to use a different app, copy both its Client ID and Client secret into Connector and save them; the two values must come from the same app.
5. In LinkedIn’s **Auth** tab, find **OAuth 2.0 settings → Authorized redirect URLs for your app**. Click the pencil / edit control. Choose **Add redirect URL** if needed.
6. Copy **LinkedIn member redirect URL** from Connector and paste the entire value into one redirect entry. At your supplied public address this is:

   ```text
   https://speak-moonwalk-granola.ngrok-free.dev/api/oauth/linkedin/callback
   ```

7. If you also use LinkedIn Campaign Manager, add a second redirect entry:

   ```text
   https://speak-moonwalk-granola.ngrok-free.dev/api/oauth/linkedin-ads/callback
   ```

   Copy the current values from Connector if your public domain has changed. The two paths are different; do not combine them into one field. Both connectors use the same saved LinkedIn Client ID and secret, so both entries belong in that app. Leave other working redirect entries in place.

8. Click **Update** or **Save** in LinkedIn and confirm the full URLs are visible in its saved redirect list. Keep `https://`, the exact domain, and the complete callback path. Do not add an extra trailing slash, spaces, quotation marks, or URL-encoded `%2F` text. Do not use the `/mcp`, `/about`, or website home-page URL here.
9. Return to Connector. If you edited credentials, click **Save and continue**. Otherwise close the setup dialog. In **Connections**, click **Connect account** on the intended LinkedIn card to start a fresh authorization. Do not reuse the old error-page URL.
10. Review LinkedIn’s requested permissions and approve the connection. Wait for it to return to Connector and show the connected account. If you get a different error, use that exact message to identify the next requirement.

Connector cannot inspect or modify the redirect list inside your LinkedIn developer account. Its setup screen shows what to register; displaying those values is not confirmation that LinkedIn has saved them. You do not need to regenerate a client secret to fix a redirect mismatch.

## Separate product permissions

The **LinkedIn** member connection requests **Sign In with LinkedIn using OpenID Connect** (`openid profile`) and **Share on LinkedIn** (`w_member_social`). Check their status under your app’s **Products**. Restricted member-read access is optional and should only be enabled in Connector after LinkedIn grants it.

The **LinkedIn Campaign Manager** connection requires approved **Advertising API** access (`r_ads rw_ads r_ads_reporting`). Conversion uploads additionally require approved `rw_conversions` access before enabling **Approved LinkedIn conversion uploads** in Connector. An application for Conversions API alone does not grant member sign-in, member publishing, or every advertising permission.

If your ngrok domain changes, return to **Check LinkedIn setup**, copy the updated URLs, register them in LinkedIn, save, and start a fresh connection. A stable assigned ngrok domain helps keep these addresses consistent.
