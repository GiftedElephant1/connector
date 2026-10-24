import { CopyValue } from "./Setup";

export function SnapchatSetup({ callbackUrl, advertising }: { callbackUrl: string; advertising: boolean }) {
  const url = new URL(callbackUrl);
  const publicReady = url.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const name = advertising ? "Snapchat Ads" : "Snapchat";
  const scope = advertising ? "snapchat-marketing-api" : "snapchat-profile-api";

  return <section aria-label={`${name} setup guide`}>
    <strong>{advertising ? "Enable Snapchat advertising access" : "Request Snapchat Public Profile API access"}</strong>
    <p>Create or select an OAuth app in <strong>Snap Business Manager / Ads Manager → Business Details</strong>, using an organization administrator account. Use the client ID and matching client secret from that app.</p>
    {advertising
      ? <p>Your Snapchat user must have access to the intended advertising account and a role that permits the requested campaign or reporting action. A connected Public Profile does not grant advertising access.</p>
      : <p>Snapchat currently requires your app to be allowlisted for the Public Profile API. Request access through your Snap contact and provide the public OAuth client ID. You also need permission to manage the intended Public Profile. Snap Kit Login Kit or Creative Kit credentials do not grant this server publishing access.</p>}
    <CopyValue label={`${name} permission Connector will request`} value={scope} />
    <p>{advertising
      ? "Connector can read ad accounts, campaigns and spend, create paused campaigns, and change campaign status or daily budgets. Enabling eligible campaigns can start spending."
      : "Connector can upload media and submit Stories or Spotlight posts to an authorized Public Profile. Snapchat still checks media eligibility, account permissions and moderation. This connection does not send private Snaps or messages."}</p>
    <strong>Register the redirect address</strong>
    <p>Add this exact address to the OAuth app’s redirect URLs, then save the matching application credentials below.</p>
    {publicReady
      ? <CopyValue label={`${name} redirect URL`} value={callbackUrl} />
      : <p className="setup-notice">Start public access in Settings, open the public workspace, and reopen this setup to copy your HTTPS redirect URL.</p>}
    <p>Keep the full <code>{advertising ? "/api/oauth/snapchat-ads/callback" : "/api/oauth/snapchat/callback"}</code> path and use the address of your running Connector workspace.</p>
    {!advertising && <p>For profiles managed by a business organization, enter its optional Snapchat organization ID below. Otherwise Connector checks the Public Profile belonging to the user who authorizes access.</p>}
    <p className="setup-help">Snapchat and Snapchat Ads store separate credentials and authorizations. If you use the same approved OAuth app for both connections, register both callback paths and enter its credentials in both setup screens. Connecting one does not connect the other.</p>
    <a href={advertising ? "https://developers.snap.com/marketing-api/Ads-API/authentication" : "https://developers.snap.com/marketing-api/Public-Profile-API/GetStarted"} target="_blank" rel="noopener noreferrer">Read Snapchat’s {advertising ? "advertising authentication" : "Public Profile API access"} instructions ↗</a>
  </section>;
}
