import { useEffect, useId, useState } from "react";
import { CopyValue, type ApiRequest } from "./Setup";
import "./x-setup.css";

type PublicDetails = {
  configured: boolean;
  operatorName: string;
  contactEmail: string;
  publicOrigin: string;
  aboutUrl: string;
  termsUrl: string;
  privacyUrl: string;
};

const scopes = [
  ["tweet.read", "Read posts, recent conversation replies, and available post metrics."],
  ["tweet.write", "Publish text posts and replies, including posts scheduled in Connector."],
  ["users.read", "Verify the X account you authorize and display its username."],
  ["dm.read", "Read recent direct-message events available to this account."],
  ["dm.write", "Send an approved one-to-one direct message or reply to a permitted recipient."],
  ["offline.access", "Renew an authorized connection using a refresh token when X permits it."],
];

function isPublicHttps(value: string | undefined): boolean {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

function UseCase({ operatorName }: { operatorName: string }) {
  const id = useId();
  const [notice, setNotice] = useState("");
  const value = `I operate a private, single-owner Connector installation${operatorName ? ` for ${operatorName}` : ""}. It connects the X account I own or am authorized to manage. I explicitly approve publishing or scheduling text posts, replying to posts and direct messages, and reading recent replies, messages, and available post metrics. Authorized AI assistants receive the tool results needed for these tasks. This is a personal account-management pipeline, not a public multi-user service. I will follow X's automation and developer rules and will not use it for spam or bulk unsolicited messages.`;
  useEffect(() => setNotice(""), [value]);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setNotice("Copied. Review the wording before submitting it to X."); }
    catch { setNotice("Select the text and copy it manually."); }
  }
  return <div className="setup-form x-use-case">
    <label htmlFor={id}>Suggested X use-case description</label>
    <textarea id={id} rows={7} value={value} readOnly onFocus={(event) => event.target.select()} />
    <button className="button button-secondary" type="button" onClick={() => void copy()}>Copy X use-case description</button>
    <p className="setup-help">Use this only if it matches your actual use. Edit your answer in X’s form to include any additional uses it asks about, including how your AI provider receives and handles results.</p>
    {notice && <p className="setup-help" role="status">{notice}</p>}
  </div>;
}

export function XSetup({ request, origin }: { request: ApiRequest; origin?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<PublicDetails | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setDetails(null);
    setError("");
    request<PublicDetails>("/api/legal").then((value) => { if (active) setDetails(value); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load your public application URLs."); });
    return () => { active = false; };
  }, [request, open, origin, attempt]);
  const publicReady = isPublicHttps(details?.publicOrigin);
  return <section className="setup-panel x-setup" aria-labelledby={`${id}-heading`}>
    <div className="eyebrow">FIRST-TIME X SETUP</div>
    <h2 id={`${id}-heading`}>Create your X developer connection</h2>
    <p className="setup-description">Follow these steps in your browser, then paste two application credentials into the fields below. Your X or Grok subscription does not include or replace X API access.</p>
    <button className="button button-secondary" type="button" aria-expanded={open} aria-controls={`${id}-guide`} onClick={() => setOpen(!open)}>{open ? "Close X setup guide" : "Set up X step by step"}</button>
    {open && <div className="x-setup-guide" id={`${id}-guide`}>
      <h3>1. Start public access in Connector</h3>
      <ol>
        <li>Keep Connector running. If public access is not on, close this dialog, open <strong>Settings</strong>, and use <strong>Make Connector available to your AI agent</strong> to start it.</li>
        <li>Click <strong>Open public workspace</strong> and sign in there with your Connector password. In that workspace, open <strong>Connections → X (Twitter) → Connect account</strong> again.</li>
        <li>Keep this tab open and use the same public HTTPS address throughout setup. The address must remain available when X returns you to Connector.</li>
      </ol>
      {!details && !error && <p className="setup-help" role="status">Loading your public application details…</p>}
      {error && <div><p className="inline-error" role="alert">{error}</p><button className="button button-secondary" type="button" onClick={() => setAttempt((value) => value + 1)}>Reload X setup URLs</button></div>}
      {details && !publicReady && <p className="setup-notice">Start public access in Settings before copying X application URLs. The current address is not a public HTTPS address.</p>}

      <h3>2. Sign in to X or create an X account</h3>
      <ol>
        <li>Open <a href="https://x.com/" target="_blank" rel="noopener noreferrer">X in a new tab ↗</a>. Sign in with the account that will own your developer application.</li>
        <li>If you do not have an X account, click <strong>Create account</strong>, enter your real details, complete any email or phone verification X requests, and set your password. Finish creating your profile before continuing.</li>
        <li>Make sure you can access that account’s verification email or phone. If X requires additional account checks or two-factor authentication, complete the prompts in X. Keep recovery codes in a safe place.</li>
      </ol>

      <h3>3. Enroll in the X Developer Portal</h3>
      <ol>
        <li>Click <strong>Open X Developer Portal</strong> below. Sign in with the same X account. Choose the portal’s sign-up, get-started, or developer-enrollment option if prompted.</li>
        <li>Enter the requested developer profile and contact details. Use your real name for a personal-name field. For an organization/company field, use your actual operator name; for a contact email, use an address you monitor.</li>
        <li>Describe your intended use of X data and APIs. Review the suggested description below and adapt it to every question the portal asks. Disclose that authorized AI assistants can receive relevant tool results.</li>
        <li>Read the developer agreement and policies. Accept them yourself only if you agree, submit the enrollment form, and complete any verification or review X requires.</li>
        <li>Review the API access, endpoint availability, quotas, credits, and pricing currently shown in your portal. Select access that supports the actions you need; X may require payment or additional approval. Connector does not choose a plan or accept charges for you.</li>
      </ol>
      <a className="button button-secondary" href="https://developer.x.com/" target="_blank" rel="noopener noreferrer">Open X Developer Portal ↗</a>
      {details && <div className="x-profile-values"><CopyValue label="X organization name (if requested)" value={details.operatorName} /><CopyValue label="X contact email (if requested)" value={details.contactEmail} /></div>}
      <UseCase operatorName={details?.operatorName || ""} />
      <p className="setup-help">Portal labels and available plans can change. An approved developer account or a successful sign-in does not guarantee access to every post, search, message, or analytics endpoint.</p>

      <h3>4. Create or select the Connector application</h3>
      <ol>
        <li>In the developer portal, open your application dashboard. If it shows <strong>Projects &amp; Apps</strong>, create a project first when required, give it a recognizable name such as <strong>Connector</strong>, and select the use case that honestly matches your account-management use.</li>
        <li>Choose <strong>Create App</strong> or the equivalent app-creation button. If you already created an app for this installation, open that app instead. Name it <strong>Connector</strong> or another unique name the portal accepts.</li>
        <li>Complete any app description and owner fields. Save the app and open its <strong>Settings</strong>.</li>
      </ol>
      <CopyValue label="X app description" value="Private account-management pipeline for owner-approved X posts, replies, direct messages, and available post metrics through authorized AI assistants." />

      <h3>5. Configure OAuth 2.0 user authentication</h3>
      <ol>
        <li>Find <strong>User authentication settings</strong> and click <strong>Set up</strong> or <strong>Edit</strong>. Enable OAuth 2.0 user authentication if the portal offers an enable switch.</li>
        <li>Select a confidential application type: <strong>Web App</strong>, or <strong>Web App, Automated App or Bot</strong> if those options are grouped. Connector runs a server and uses a client secret; a public/native app type will not match this connection.</li>
        <li>If the portal offers <strong>App permissions</strong>, choose <strong>Read and Write and Direct message</strong> (or equivalent) for all the supported Connector actions. Read-only access cannot publish; direct-message actions require DM access.</li>
        <li>Paste the exact callback below into <strong>Callback URI / Redirect URL</strong>. Paste the website, Terms, and Privacy URLs into the corresponding fields when requested. Do not add a trailing slash to the callback or use the MCP URL here.</li>
        <li>Open the website and policy links in a signed-out window to confirm they are reachable. Save your authentication settings in the developer portal.</li>
      </ol>
      {publicReady && details && <div className="x-setup-urls">
        <CopyValue label="X callback / redirect URL" value={`${details.publicOrigin}/api/oauth/x/callback`} />
        <CopyValue label="X website URL" value={details.aboutUrl} />
        {details.configured ? <><CopyValue label="X Terms of Service URL" value={details.termsUrl} /><CopyValue label="X Privacy Policy URL" value={details.privacyUrl} /></> : <p className="setup-notice">Save the public operator details in Settings before submitting policy URLs.</p>}
      </div>}
      <p className="setup-help">Connector requests the following OAuth 2.0 scopes when you click Connect. If your portal has a scope selector, enable these; otherwise the authorization screen requests them. Changing older app-permission controls alone does not grant new scopes to an existing connection.</p>
      <dl className="x-scope-list">{scopes.map(([scope, meaning]) => <div key={scope}><dt><code>{scope}</code></dt><dd>{meaning}</dd></div>)}</dl>

      <h3>6. Copy the OAuth 2.0 Client ID and Client Secret</h3>
      <ol>
        <li>After saving authentication settings, find the app’s <strong>OAuth 2.0 Client ID and Client Secret</strong>. These may appear immediately or under <strong>Keys and tokens</strong>.</li>
        <li>Click the copy button beside <strong>Client ID</strong>. Return to this Connector tab, click the <strong>X OAuth client ID</strong> field below the guide, and paste it.</li>
        <li>Return to X. Generate or reveal the OAuth 2.0 <strong>Client Secret</strong> if needed, then copy it. Return to Connector, click <strong>X OAuth client secret</strong>, and paste it. If X only shows the secret once, keep a copy in your password manager.</li>
        <li>Use the OAuth 2.0 values specifically. The separate <strong>API Key</strong>, <strong>API Key Secret</strong>, <strong>Bearer Token</strong>, and OAuth 1.0a access tokens do not fit these two fields. Do not paste credentials into a chat or screenshot.</li>
      </ol>

      <h3>7. Save and authorize your X account</h3>
      <ol>
        <li>Below this guide, click <strong>Save and continue</strong>. The Connect account flow then opens X authorization. If you opened this dialog only to edit application settings, return to Connections and click the X card’s <strong>Connect account</strong> after saving.</li>
        <li>On X’s authorization screen, confirm the username is the account you want this installation to manage. Switch accounts in X first if necessary. Review the permissions and choose <strong>Authorize app</strong> or the equivalent approval button.</li>
        <li>Wait for the browser to return to the same public Connector address. The X card should show a connected status and your <strong>@username</strong>. Connector verifies the authorized identity through X’s account API before saving the connection.</li>
        <li>You can use <strong>Verify connection</strong> on the X card to repeat that account check. Reading the account does not post anything. Test a read action before asking an authorized AI assistant to publish or send a message; review each write before approving it.</li>
      </ol>

      <h3>8. Fix common setup problems</h3>
      <ul>
        <li><strong>Callback / redirect mismatch:</strong> compare X’s saved callback character for character with the value above. Keep the same HTTPS domain and the complete <code>/api/oauth/x/callback</code> path. If your public address changes, update X’s callback, website, and policy URLs, save, and connect again.</li>
        <li><strong>Invalid client or token exchange failed:</strong> confirm you selected a confidential web app and pasted the OAuth 2.0 Client ID and Client Secret from that exact app. If you regenerated the secret, replace its saved value in Connector before reconnecting.</li>
        <li><strong>Access denied or missing permissions:</strong> complete developer enrollment and check the app’s API access and requested scopes. If you changed scopes or previously connected read-only, disconnect and authorize X again so it can grant the new permissions.</li>
        <li><strong>Connected, but a post, DM, search, or metric fails:</strong> check that your X API access includes that endpoint, the recipient permits the DM, and your account is eligible. Some owned-post metrics are limited to recent posts. Check current quota, billing, and rate limits; signing in successfully does not remove those limits.</li>
        <li><strong>Expired authorization or return to the wrong page:</strong> open and sign in to Connector’s public workspace first, keep it running, then restart Connect account. Avoid beginning the flow in localhost and finishing it on the public domain.</li>
      </ul>
      <p className="setup-help">This guide configures the X social connector. X advertising has a separate connector and access requirements. It does not create an xAI API account or connect your Grok subscription.</p>
      <a href="https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code" target="_blank" rel="noopener noreferrer">X’s official OAuth 2.0 instructions ↗</a>
    </div>}
  </section>;
}
