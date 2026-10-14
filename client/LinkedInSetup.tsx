import { CopyValue } from "./Setup";

export function LinkedInSetup({ callbackUrl, clientId, advertising = false, memberRead = false, conversions = false }: { callbackUrl: string; clientId: string; advertising?: boolean; memberRead?: boolean; conversions?: boolean }) {
  const origin = new URL(callbackUrl).origin;
  const publicReady = origin.startsWith("https://") && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  const scopes = advertising
    ? ["r_ads", "rw_ads", "r_ads_reporting", ...(conversions ? ["rw_conversions"] : [])]
    : ["openid", "profile", "w_member_social", ...(memberRead ? ["r_member_social"] : [])];
  return <div>
    <strong>Check LinkedIn products and permissions</strong>
    <p>Open your LinkedIn developer app’s <strong>Auth → OAuth 2.0 scopes</strong>. Every permission below must appear in that list before connecting. Correct credentials and redirect URLs alone do not grant these permissions.</p>
    <CopyValue label="Permissions Connector will request" value={scopes.join(" ")} />
    {advertising ? <>
      <p>Under <strong>Products</strong>, request <strong>Advertising API</strong> access and wait for approval. Confirm <code>r_ads</code>, <code>rw_ads</code>, and <code>r_ads_reporting</code> appear under Auth.</p>
      <p>Set <strong>Approved LinkedIn conversion uploads</strong> to <strong>true</strong> only when <code>rw_conversions</code> also appears in Auth. Otherwise keep it <strong>false</strong>; campaign management and spend reporting can still connect.</p>
    </> : <>
      <ol>
        <li>Open <strong>Products</strong> and find <strong>Sign In with LinkedIn using OpenID Connect</strong>. Click <strong>Request access</strong> or the access button offered, then complete LinkedIn’s prompts.</li>
        <li>Wait until access is granted. Return to <strong>Auth → OAuth 2.0 scopes</strong> and confirm both <code>openid</code> and <code>profile</code> appear.</li>
        <li>Also confirm <code>w_member_social</code> appears for posting. If it is missing, request <strong>Share on LinkedIn</strong> under Products. If it is already listed, that posting permission is available.</li>
        <li>Keep <strong>Approved LinkedIn member reading</strong> below set to <strong>false</strong> unless Auth also lists the restricted <code>r_member_social</code> permission.</li>
      </ol>
      <p className="setup-notice"><code>r_basicprofile</code> does not replace <code>openid</code> or <code>profile</code>. If LinkedIn shows “Bummer, something went wrong” and redirects you back, missing product permissions are one possible cause. Check this scope list and any error shown after returning.</p>
    </>}
    <p className="setup-help">The permission list above reflects your choices in this form. Save changed choices before connecting. Connector cannot inspect your app’s approved products; compare the list in LinkedIn yourself. Product approval and redirect registration are separate steps.</p>
    <strong>Register LinkedIn’s exact redirect addresses</strong>
    <p>“The redirect_uri does not match the registered value” means LinkedIn has not accepted this callback for the selected developer app. Saving a Client ID and secret in Connector does not register the callback in LinkedIn.</p>
    <ol>
      <li>Open <a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noopener noreferrer">LinkedIn’s developer apps ↗</a> and select your Connector application.</li>
      <li>Open its <strong>Auth</strong> tab. Compare its <strong>Client ID</strong> with the value below. If they differ, select the matching app, or enter the correct app’s Client ID and secret in Connector.</li>
      <li>Under <strong>OAuth 2.0 settings</strong>, find <strong>Authorized redirect URLs for your app</strong>. Click the pencil / edit control, then <strong>Add redirect URL</strong>.</li>
      <li>Copy the member redirect below and paste it as one complete URL. Add the Campaign Manager redirect as a second entry if you use advertising. Click <strong>Update</strong> or <strong>Save</strong> and confirm the saved entries are visible.</li>
      <li>Return to Connector’s public workspace. If you changed the application fields below, click <strong>Save and continue</strong>; otherwise close this setup. If authorization has not started, click <strong>Connect account</strong> on the intended LinkedIn card. A page refresh on LinkedIn’s old error screen does not start a new connection.</li>
    </ol>
    {clientId ? <CopyValue label="LinkedIn Client ID to match in the Auth tab" value={clientId} /> : <p className="setup-help">Paste the Client ID from your chosen LinkedIn app in the application fields below.</p>}
    {publicReady ? <>
      <CopyValue label="LinkedIn member redirect URL" value={callbackUrl.endsWith("/linkedin/callback") ? callbackUrl : `${origin}/api/oauth/linkedin/callback`} />
      <CopyValue label="LinkedIn Campaign Manager redirect URL" value={callbackUrl.endsWith("/linkedin-ads/callback") ? callbackUrl : `${origin}/api/oauth/linkedin-ads/callback`} />
    </> : <p className="setup-notice">Start public access in Settings, open the public workspace, and reopen this setup to copy your HTTPS redirect URLs.</p>}
    <p>Register the complete address, including <code>/api/oauth/linkedin/callback</code> or <code>/api/oauth/linkedin-ads/callback</code>. Do not use your website’s home page, <code>/mcp</code>, an old ngrok address, or an extra trailing slash. If your public address changes, update these entries in LinkedIn before connecting again.</p>
    <p className="setup-help">Both LinkedIn connectors use the same saved Client ID and secret. Register their URLs in that same app. Connector cannot read or change the developer app’s saved redirect list; you must save these entries on LinkedIn.</p>
    <p className="setup-help">If a client secret was exposed, generate a replacement in LinkedIn’s Auth tab, save it privately in the application fields below, and revoke the exposed secret in LinkedIn. Rotating the secret does not grant missing product permissions.</p>
  </div>;
}
