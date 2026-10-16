import { CopyValue } from "./Setup";

export function PinterestAdsSetup({ callbackUrl }: { callbackUrl: string }) {
  const url = new URL(callbackUrl);
  const publicReady = url.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return <div>
    <strong>Approve Pinterest advertising access</strong>
    <p>Use a Pinterest developer app with access to advertising endpoints. Trial access is limited to eligible accounts; access for other users may require Pinterest review and Standard access. Your Pinterest sign-in must also have a role on the ad account that permits the requested action.</p>
    <CopyValue label="Pinterest Ads permissions Connector will request" value="ads:read,ads:write" />
    <p><code>ads:read</code> allows ad account discovery, campaign reads, and spend reporting. <code>ads:write</code> allows campaign creation, budget changes, and campaign status changes. Connector creates campaigns paused. Enabling a configured campaign can start spending and requires an explicit confirmed action.</p>
    <strong>Register the Pinterest Ads redirect address</strong>
    <p>In your Pinterest developer app, add this exact address to its redirect URLs and save it. Use the app’s ID and matching secret in the fields below.</p>
    {publicReady
      ? <CopyValue label="Pinterest Ads redirect URL" value={callbackUrl} />
      : <p className="setup-notice">Start public access in Settings, open the public workspace, and reopen this setup to copy your HTTPS redirect URL.</p>}
    <p>Keep the full <code>/api/oauth/pinterest-ads/callback</code> path. Your public website, an organic Pinterest callback, and an old ngrok address are different URLs.</p>
    <strong>Connect your advertising account separately</strong>
    <ol>
      <li>Save the Pinterest Ads app ID and app secret below, then complete Pinterest’s consent screen.</li>
      <li>Sign in as the Pinterest business user who has access to your intended ad account.</li>
      <li>Open <strong>Pinterest Ads → View connection → Available resources</strong> and find the ad account. Give its ID to your AI when asking for campaigns or spend.</li>
    </ol>
    <p className="setup-help">The Pinterest card continues to handle boards and Pins. Pinterest Ads stores its own credentials and authorization. If you deliberately use the same approved developer app for both, register both callbacks and enter its credentials in each setup; Connector does not copy them automatically.</p>
  </div>;
}
