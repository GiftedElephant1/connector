import profile from "./public-profile.json";
import { CopyValue } from "./Setup";

const callbacks = [
  ["YouTube redirect URI", "/api/oauth/youtube/callback"],
  ["Google Ads redirect URI", "/api/oauth/google-ads/callback"],
  ["Google Analytics redirect URI", "/api/oauth/google-analytics/callback"],
  ["Google Search Console redirect URI", "/api/oauth/search-console/callback"],
  ["Google Workspace redirect URI", "/api/workspace/google/callback"],
] as const;

export function GoogleSetup({ callbackUrl }: { callbackUrl: string }) {
  let runtime: URL | undefined;
  try { runtime = new URL(callbackUrl); } catch { /* No copyable callbacks until the workspace URL is valid. */ }
  const publicReady = runtime?.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(runtime.hostname);
  const homepage = new URL("/", profile.siteUrl).href;
  const domain = new URL(homepage).hostname.replace(/^connector\./, "");

  return <section aria-label="Google setup guide">
    <strong>Google sign-in and branding setup</strong>
    <p>Use the same Google Cloud project and web application client already saved in Connector. Updating its branding and redirect list preserves your saved credentials and existing connections.</p>

    <details>
      <summary>1. Publish and verify the public website</summary>
      <p>The public website explains Connector and links to its privacy policy and terms. Publish it and check these pages in a signed-out browser before submitting them to Google. These addresses are prepared values, not a confirmation that deployment or verification has finished.</p>
      <ol>
        <li>Open the Connector repository’s <strong>Settings → Pages</strong> and choose <strong>GitHub Actions</strong> as the source. Open <strong>Actions → Publish public website → Run workflow</strong>, choose <strong>main</strong>, and run it. Check the deployment link.</li>
        <li>Follow the <a href="https://github.com/GiftedElephant1/connector/blob/main/docs/public-website.md" target="_blank" rel="noopener noreferrer">public website publishing guide ↗</a> to verify the custom domain in your GitHub account. Then set the repository’s <strong>Settings → Pages → Custom domain</strong> to <strong>{profile.customDomain}</strong>.</li>
        <li>In GoDaddy, open <strong>My Products → Domains → {domain} → DNS → Add new record</strong>. Choose <strong>CNAME</strong>, set <strong>Name</strong> to <code>connector</code>, <strong>Value</strong> to <code>GiftedElephant1.github.io</code>, and save. If a record already uses the name <code>connector</code>, resolve that record only; keep the root website and email records.</li>
        <li>Wait for GitHub’s DNS check and certificate, then enable <strong>Enforce HTTPS</strong> in Pages. Run <strong>Publish public website</strong> again so links use the custom domain. Open the homepage, privacy policy, and terms in an incognito window. All three must load without a login, password, or tunnel warning.</li>
        <li>Open <a href="https://search.google.com/search-console" target="_blank" rel="noopener noreferrer">Google Search Console ↗</a> using a Google account that is an owner or editor of the Cloud project. Add a <strong>Domain</strong> property for <strong>{domain}</strong>. Follow Google’s DNS verification instructions; if it supplies a TXT record, add that exact value at <code>@</code> in GoDaddy and click <strong>Verify</strong>. Keep the verification record.</li>
      </ol>
      <p className="setup-help">The public website does not host your private Connector workspace or OAuth callbacks. Keep the public workspace address in Connector Settings pointing to the running Connector server.</p>
    </details>

    <details open>
      <summary>2. Fill in Google Auth Platform → Branding</summary>
      <p>Open <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener noreferrer">Google Auth Platform → Branding ↗</a> in the project containing your saved client ID. Enter the following values after the website is public and domain ownership is verified.</p>
      <CopyValue label="Google app name" value="Connector" />
      <CopyValue label="Google support and developer contact email" value={profile.contactEmail} />
      <p className="setup-help">Google may limit the support-email dropdown to project users or eligible Google Groups. Make your monitored support address eligible, or select another monitored address you control. Developer contact details are entered separately.</p>
      <CopyValue label="Google application home page" value={homepage} />
      <CopyValue label="Google privacy policy URL" value={new URL("privacy/", homepage).href} />
      <CopyValue label="Google terms of service URL" value={new URL("terms/", homepage).href} />
      <CopyValue label="Google authorized domain" value={domain} />
      <p>Save all changes. Use the Connector homepage rather than a company page that does not explain this app. The homepage must visibly link to the privacy policy. A temporary ngrok privacy URL does not establish ownership of your business domain.</p>
    </details>

    <details>
      <summary>3. Choose the audience and permissions</summary>
      <ol>
        <li>Open <strong>Google Auth Platform → Audience</strong>. For personal Google accounts or a YouTube Brand Account that Google treats as outside your organization, choose <strong>External</strong>. An Internal app can produce <code>403: org_internal</code> for those identities.</li>
        <li>While in <strong>Testing</strong>, add each actual Google sign-in email under <strong>Test users</strong>. Use the email of a person who can access the YouTube channel; a channel name such as “Vectre Pay” is not a test-user email.</li>
        <li>Under <strong>Data Access</strong>, declare the scopes for the connectors you actually use. Enable the corresponding APIs under <strong>APIs &amp; Services → Library</strong>. Branding verification and sensitive or restricted scope verification are separate reviews.</li>
        <li>For ongoing use, review Google’s requirements and move to <strong>Production</strong> when ready. External apps in Testing generally receive refresh tokens that expire after seven days for these integrations. Publishing alone does not verify scopes or guarantee approval; complete any verification or security assessment Google requires.</li>
      </ol>
    </details>

    <details open>
      <summary>4. Register the running workspace’s redirect URIs</summary>
      <p>Open <strong>Google Auth Platform → Clients</strong> and select the <strong>Web application</strong> client matching the client ID saved below. Add each callback you use to <strong>Authorized redirect URIs</strong>, keep existing entries, and save. Branding URLs and redirect URIs serve different purposes.</p>
      {publicReady && runtime ? callbacks.map(([label, path]) => <CopyValue key={path} label={label} value={runtime.pathname === path ? callbackUrl : new URL(path, runtime.origin).href} />) : <p className="setup-notice">Start public access in Connector Settings, then reopen this setup to copy the running workspace’s HTTPS redirect URIs.</p>}
      <p>Use these complete callback addresses, including the path and without an extra trailing slash. Never replace their host with the static public website’s address. If your running workspace address changes, update these entries before starting a fresh connection.</p>
      {runtime?.hostname.endsWith(".ngrok-free.dev") && <p className="setup-notice">Your running workspace still uses ngrok. If Google requires ownership verification for that callback domain, move the running workspace to a separate HTTPS hostname on your own domain and register its new callbacks. Publishing the static website does not move the workspace.</p>}
      <p className="setup-help"><code>redirect_uri_mismatch</code> means Google received a callback that does not match this client’s saved list. Google’s error details show the received value. Allow time for saved changes to apply, then use Connect account again; refreshing an old error page reuses the old request.</p>
    </details>

    <details>
      <summary>5. Recheck and submit for review</summary>
      <p>Visit the public pages while signed out, confirm the homepage explains the app and links to privacy, and check domain verification, app name, support email, audience, and scopes in the same Cloud project. Return to Google’s <strong>Verification Center</strong> (or the review prompt in Branding) and submit the corrected information. Review status is controlled by Google; Connector cannot grant approval.</p>
      <p>Keep your existing client ID and secret. Do not use Disable and reset to fix branding. When sign-in is available, return to Connections, start a fresh connection, and choose the Google account and channel you intend to authorize.</p>
    </details>
  </section>;
}
