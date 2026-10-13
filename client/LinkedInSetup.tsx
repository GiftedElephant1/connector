import { CopyValue } from "./Setup";

export function LinkedInSetup({ callbackUrl, clientId }: { callbackUrl: string; clientId: string }) {
  const origin = new URL(callbackUrl).origin;
  const publicReady = origin.startsWith("https://") && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  return <div>
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
    <p className="setup-help">For the member connection, enable Sign In with LinkedIn using OpenID Connect and Share on LinkedIn under Products. Campaign Manager requires separate Advertising API approval; conversion uploads additionally require approved conversion access. Product approval and redirect registration are separate steps.</p>
  </div>;
}
