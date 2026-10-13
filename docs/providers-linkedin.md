# Fix LinkedIn redirect registration

**“The redirect_uri does not match the registered value”** is an error from LinkedIn before account authorization. The callback Connector sends must be registered in the LinkedIn developer app identified by its saved Client ID. A website URL, product application, or saved client secret does not register this callback.

You can correct this in LinkedIn without reinstalling Connector or disconnecting your other accounts.

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
