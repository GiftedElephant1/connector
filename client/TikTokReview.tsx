import { useEffect, useId, useState, type ChangeEvent, type FormEvent } from "react";
import { CopyValue, type ApiRequest } from "./Setup";
import { TikTokVerification } from "./TikTokVerification";
import "./tiktok-review.css";

type LegalSettings = {
  configured: boolean;
  operatorName: string;
  contactEmail: string;
  updatedAt?: string | null;
  publicOrigin: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
  aboutUrl: string | null;
  iconUrl: string | null;
};

const appDescription = "Self-hosted AI connector for authorized TikTok accounts: video posting, publishing status, and owned-video metrics.";

const productsExplanation = `Connector is a self-hosted web application used by its owner to connect authorized accounts to an AI assistant and perform explicit account actions.

Login Kit — user.info.basic: The owner clicks Connect account, signs in on TikTok’s authorization screen, and grants access. Connector retrieves the authorized creator’s basic profile to identify the connected account. The owner can disconnect it in Connector.

Content Posting API, Direct Post — video.publish: Connector retrieves the creator’s posting options, shows the selected video and account, and asks the owner to choose privacy and interaction settings and confirm the content declarations. Only after the owner’s explicit approval does Connector submit the video. Connector can check the resulting publish status. Unaudited clients follow TikTok’s private-post restrictions.

Display API — video.list: Connector queries a video owned by the authorized creator and reads its available metrics, including view, like, comment, and share counts. These results can be viewed in Connector or retrieved by an AI assistant the owner authorizes.

Connector requests user.info.basic, video.publish, and video.list. This integration does not use Share Kit or the video.upload scope. TikTok comments, direct messages, and advertising are not part of this integration.`;

const recordingSteps = [
  "Use the TikTok Developer Portal sandbox if this app has not been approved. Add the TikTok account you will use as a sandbox target user and select only Login Kit, Display API, and Content Posting API / Direct Post with user.info.basic, video.list, and video.publish.",
  "Open Connector at the same public HTTPS domain entered as the website URL in the Developer Portal. Keep the address bar visible. Open About, Terms, and Privacy to show the working public pages.",
  "In Connector, open Connections, find TikTok, and click Connect account. Record the real TikTok sign-in and consent flow, return to Connector, and show the connected creator account. Do not record passwords or secret keys.",
  "Open TikTok publishing. Show the creator’s current options (use Refresh publishing options if needed). Enter a direct HTTPS video URL from a domain or URL prefix verified for your TikTok app. Click Preview video and play it. Choose the allowed privacy setting, interaction settings, and content declarations. Click Review video, show the final review, and explicitly approve Publish to TikTok. Use private visibility for an unaudited app and non-branded test content.",
  "Click Check publication status and show the result for that submission, including completion or the actual restriction shown by TikTok. Show the resulting video in the test TikTok account when available. Do not present a restriction or a simulated response as a successful post.",
  "Use Read video metrics with the ID of an existing public video owned by the test creator. Show actual returned counts to demonstrate Display API and video.list; a new private sandbox post may not be available through Display API. If sandbox restrictions prevent a required product or scope from working, resolve them or remove that product or scope before submitting.",
  "Save the recording as MP4 or MOV. Submit at least one video, no more than five files, and no file larger than 50 MB. Check the selected files below, then upload them yourself in TikTok’s Developer Portal.",
];

function CopyText({ label, value }: { label: string; value: string }) {
  const id = useId();
  const [notice, setNotice] = useState("");
  useEffect(() => setNotice(""), [value]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Copied.");
    } catch {
      setNotice("Select the text and copy it manually.");
    }
  }
  return (
    <div className="review-copy setup-form">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} value={value} readOnly rows={value.length > 500 ? 12 : 4} onFocus={(event) => event.target.select()} />
      <div className="setup-button-row">
        <button type="button" className="button button-secondary" onClick={() => void copy()}>Copy {label.toLowerCase()}</button>
        <span className="setup-help" role="status">{notice}</span>
      </div>
    </div>
  );
}

function DemoFiles() {
  const id = useId();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  function choose(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files || []);
    const errors: string[] = [];
    if (selected.length > 5) errors.push("Choose no more than five demo files.");
    for (const file of selected) {
      if (!/\.(mp4|mov)$/i.test(file.name)) errors.push(`${file.name}: use MP4 or MOV.`);
      if (file.size === 0) errors.push(`${file.name}: this file is empty.`);
      if (file.size > 50_000_000) errors.push(`${file.name}: exceeds the 50 MB limit.`);
    }
    setError(errors.join(" "));
    setFiles(errors.length ? [] : selected);
  }
  return (
    <div className="setup-form review-demo-files">
      <label htmlFor={id}>Check your demo files</label>
      <input id={id} type="file" accept=".mp4,.mov,video/mp4,video/quicktime" multiple onChange={choose} />
      <p className="setup-help">Files stay in your browser. This checks filenames, file count, and size; it does not upload files or certify the recording’s contents.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {files.length > 0 && (
        <>
          <p className="setup-notice" role="status">{files.length} {files.length === 1 ? "file meets" : "files meet"} the format-name and size limits. Watch each recording before uploading it to TikTok.</p>
          {files.map((file, index) => <DemoPreview key={`${file.name}-${file.lastModified}-${index}`} file={file} />)}
        </>
      )}
    </div>
  );
}

function DemoPreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    setError(false);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return (
    <figure className="review-video">
      <figcaption>{file.name} · {(file.size / 1_000_000).toFixed(2)} MB</figcaption>
      {url && <video src={url} controls preload="metadata" aria-label={`Preview ${file.name}`} onError={() => setError(true)} />}
      {error && <p className="setup-help">This browser could not preview the recording. Open it in your PC’s video player to check it.</p>}
    </figure>
  );
}

export function TikTokReview({ request, origin }: { request: ApiRequest; origin?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [legal, setLegal] = useState<LegalSettings | null>(null);
  const [operatorName, setOperatorName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [changes, setChanges] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    request<LegalSettings>("/api/legal").then((result) => {
      if (!active) return;
      setLegal(result);
      setOperatorName(result.operatorName || "");
      setContactEmail(result.contactEmail || "");
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load public page settings.");
    });
    return () => { active = false; };
  }, [request, open, origin, attempt]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<LegalSettings>("/api/legal", {
        method: "PUT",
        body: JSON.stringify({ operatorName: operatorName.trim(), contactEmail: contactEmail.trim() }),
      });
      setLegal(result);
      setOperatorName(result.operatorName);
      setContactEmail(result.contactEmail);
      setNotice("Public page details saved. Preview the pages before submitting them.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save public page settings.");
    } finally {
      setBusy(false);
    }
  }
  const publicReady = !!legal?.configured && legal.publicOrigin?.startsWith("https://");
  return (
    <section className="setup-panel tiktok-review" aria-labelledby={`${id}-title`}>
      <div className="eyebrow">DEVELOPER PORTAL MATERIALS</div>
      <h2 id={`${id}-title`}>TikTok app review</h2>
      <p className="setup-description">Follow the complete developer-account setup, create your TikTok app, copy its required information, connect a sandbox account, and prepare the review recording.</p>
      <button className="button button-secondary" type="button" aria-expanded={open} aria-controls={`${id}-contents`} onClick={() => setOpen(!open)}>{open ? "Close TikTok submission materials" : "Prepare TikTok submission"}</button>
      {open && <div id={`${id}-contents`} className="review-contents">
        <h3>1. Create your TikTok developer account and web app</h3>
        <p className="setup-help">Have access to your contact email inbox and the TikTok account you will test with. Keep this guide open in one tab and TikTok’s portal in another. Portal labels can change; follow its current registration prompts.</p>
        <a className="button button-secondary" href="https://developers.tiktok.com/" target="_blank" rel="noopener noreferrer">Open TikTok for Developers ↗</a>
        <ol className="review-recording-steps">
          <li>Open the link above. Choose the portal’s sign-up or getting-started option. If you already have a developer account, choose its sign-in option instead. If TikTok first asks you to sign in to a TikTok account, use the account you are authorized to manage.</li>
          <li>Complete the registration form and any required developer agreements. When asked for a business or contact email for this installation, use <strong>{legal?.contactEmail || "contact@vectrepay.com"}</strong>. If the portal sends a verification code or link, open that email inbox, find TikTok’s message (including Spam or Junk), and enter the code or open the link to finish verification.</li>
          <li>Complete the developer profile with your actual details. Use <strong>{legal?.operatorName || "Vectre Pay Inc"}</strong> when asked for the organization operating this app. If TikTok asks for a legal representative, business address, or verification documents, enter the real information it requests; these are not generated by Connector.</li>
          <li>Open the developer app-management area, choose the option to create a new app, and enter <strong>Connector</strong> as the app name. Select <strong>Web</strong> as the platform when offered. This is a browser app running on your PC at a public HTTPS address, so do not choose a native mobile-app platform for this integration.</li>
          <li>Keep the app’s configuration page open. Complete its website, policy, icon, description, product, and scope fields using sections 2–4 below. Save the draft when the portal allows it; do not submit it for review until the real sandbox recording works.</li>
        </ol>
        <h3>2. Add your website and policy URLs</h3>
        <p className="setup-help">Enter the person or organization operating this installation and an email people can contact. These details will appear publicly. Review the generated policies to make sure they describe your use.</p>
        {!legal && !error && <p role="status">Loading public page settings…</p>}
        {legal && <>
          <form className="setup-form" onSubmit={save}>
            <label htmlFor={`${id}-operator`}>App operator name</label>
            <input id={`${id}-operator`} value={operatorName} onChange={(event) => setOperatorName(event.target.value)} maxLength={120} required disabled={busy} autoComplete="organization" />
            <label htmlFor={`${id}-contact`}>Public contact email</label>
            <input id={`${id}-contact`} type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} maxLength={254} required disabled={busy} autoComplete="email" />
            <button type="submit" className="button button-primary" disabled={busy || !operatorName.trim() || !contactEmail.trim()}>{busy ? "Saving public page details…" : "Save public page details"}</button>
          </form>
          {notice && <p className="setup-notice" role="status">{notice}</p>}
          {!legal.configured && <p className="setup-help">Save your operator name and contact email to publish the terms and privacy policy.</p>}
          {!legal.publicOrigin?.startsWith("https://") && <p className="setup-help">Start public access above before copying submission URLs. TikTok needs a working public HTTPS address. If you opened this guide inside TikTok setup, close that dialog, open Settings, and use Make Connector available to your AI agent. Then open your public workspace and return to TikTok setup.</p>}
          {publicReady && <div className="review-urls">
            {legal.aboutUrl && <CopyValue label="TikTok website URL" value={legal.aboutUrl} />}
            {legal.termsUrl && <CopyValue label="Terms of Service URL" value={legal.termsUrl} />}
            {legal.privacyUrl && <CopyValue label="Privacy Policy URL" value={legal.privacyUrl} />}
          </div>}
          <nav className="review-preview-links" aria-label="Preview public pages">
            <a href={legal.aboutUrl || "/about"} target="_blank" rel="noopener noreferrer">Preview About ↗</a>
            <a href={legal.termsUrl || "/terms"} target="_blank" rel="noopener noreferrer">Preview Terms ↗</a>
            <a href={legal.privacyUrl || "/privacy"} target="_blank" rel="noopener noreferrer">Preview Privacy ↗</a>
          </nav>
          <p className="setup-help">Use the same public domain for your website URL, sign-in redirect, policy pages, and demo. Keep Connector running and public access on during review; a saved URL alone does not keep the site online.</p>
          <p className="setup-help">In the developer app’s basic information, paste each value into the matching Website URL, Terms of Service URL, and Privacy Policy URL field. Open each URL in an incognito or signed-out browser window and confirm it loads without a Connector password. If the portal asks for ownership verification, complete its domain or URL verification instructions; these policy pages do not verify ownership automatically.</p>
          <TikTokVerification request={request} origin={legal.publicOrigin} />
        </>}
        {error && <div><p className="inline-error" role="alert">{error}</p>{!legal && <button className="button button-secondary" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry public page settings</button>}</div>}
        <h3>3. Add the icon and description</h3>
        <div className="review-icon-row">
          <img src="/assets/connector-icon.png" alt="Connector app icon" width="80" height="80" />
          <a className="button button-secondary" href="/assets/connector-icon.png" download="connector-icon.png">Download app icon (PNG)</a>
        </div>
        <CopyValue label="TikTok app name" value="Connector" />
        <CopyText label="App description" value={appDescription} />
        <p className="setup-help">Click Download app icon, find connector-icon.png in your browser’s Downloads, then choose that file in TikTok’s icon-upload field. Copy the app name and description above into the matching fields and save the app draft.</p>
        <h3>4. Set up products, scopes, and the login redirect</h3>
        <p className="setup-help">Select only Login Kit, Display API, and Content Posting API / Direct Post. Request only user.info.basic, video.list, and video.publish. Remove Share Kit, video.upload, and any other unused products or scopes.</p>
        <ol className="review-recording-steps">
          <li>In the app’s product or permission settings, add <strong>Login Kit for Web</strong> and the <strong>user.info.basic</strong> scope to connect and identify your TikTok account.</li>
          <li>Add <strong>Display API</strong> and <strong>video.list</strong> to read metrics for videos owned by that account.</li>
          <li>Add <strong>Content Posting API</strong>, enable its <strong>Direct Post</strong> configuration when offered, and request <strong>video.publish</strong> for explicit video submissions. Check the eligibility note below before requesting this product.</li>
          <li>In Login Kit’s web redirect settings, add the exact <strong>TikTok Login Kit redirect URI</strong> below. It ends in /api/oauth/tiktok/callback. Save it without changing the scheme, domain, or path. This is different from your website URL and your AI connector’s /mcp address.</li>
        </ol>
        {publicReady && <CopyValue label="TikTok Login Kit redirect URI" value={`${legal.publicOrigin}/api/oauth/tiktok/callback`} />}
        {!publicReady && <p className="setup-help">The redirect URI will appear here after your public HTTPS address and policy details are ready. Do not register a localhost address for this web integration.</p>}
        <p className="setup-help">Paste the explanation below into TikTok’s “Explain how each product and scope works within your app or website” question. Leave the revision field blank for a first application; fill it only if you are revising a previously approved submission.</p>
        <div className="setup-form">
          <label htmlFor={`${id}-revision`}>Changes since your last approved submission (revisions only)</label>
          <textarea id={`${id}-revision`} value={changes} onChange={(event) => setChanges(event.target.value)} rows={3} maxLength={3000} placeholder="Leave blank for a first submission. For a revision, describe what changed since the approved version." />
        </div>
        <CopyText label="Products and scopes explanation" value={productsExplanation + (changes.trim() ? `\n\nChanges in this revision: ${changes.trim()}` : "")} />
        <p className="setup-help">TikTok’s <a href="https://developers.tiktok.com/doc/content-sharing-guidelines" target="_blank" rel="noopener noreferrer">Content Posting guidelines</a> exclude internal utilities for accounts managed by the developer or their team. That matters for this personal pipeline. Describe your use accurately and check eligibility; public policy pages and a sandbox demo do not establish approval.</p>
        <h3>5. Add a sandbox test user and connect the account</h3>
        <ol className="review-recording-steps">
          <li>For an app that has not been approved, open its <strong>Sandbox</strong> environment in the Developer Portal. Follow its option to add a target or test user. Use the TikTok account you intend to demonstrate, and complete any invitation or authorization TikTok requires for that user.</li>
          <li>Confirm the sandbox uses the products, scopes, and exact login redirect from section 4. Open the sandbox app’s credentials. Copy its <strong>client key</strong> and <strong>client secret</strong>; use both from the same app and environment. The client key is not your TikTok username, and the client secret is not your TikTok password.</li>
          <li>Return to Connector at its public HTTPS address and sign in with your Connector password. Open <strong>Connections</strong>, search for <strong>TikTok</strong>, and click <strong>Connect account</strong>. If TikTok application details are already saved, use <strong>Settings → Platform application settings → TikTok → Manage setup</strong> to edit them.</li>
          <li>In Set up TikTok, close the submission materials if needed to reach the application fields below. Paste the client key into <strong>TikTok client key</strong> and the client secret into <strong>TikTok client secret</strong>. Click <strong>Save and continue</strong>. Keep the client secret out of chat messages, screenshots, and the demo recording.</li>
          <li>If you opened setup through Manage setup, return to Connections and click TikTok’s <strong>Connect account</strong>. On the actual TikTok screen, sign in as the sandbox test user, review the requested permissions, and authorize the connection. Wait to return to Connector and confirm it shows the expected connected account.</li>
          <li>Open <strong>TikTok publishing</strong> to test the creator options, verified-source video preview, explicit publishing choices, publication status, and real owned-video metrics. For a new app, sandbox success does not mean production approval. Complete the recording in section 6, attach it to the application, check that all selected scopes are demonstrated, then submit it through TikTok’s review flow.</li>
        </ol>
        <p className="setup-help">Connector keeps your application credentials encrypted. Complete TikTok’s own sign-in and developer verification on its website. For current portal instructions, see <a href="https://developers.tiktok.com/doc/login-kit-web" target="_blank" rel="noopener noreferrer">Login Kit for Web</a> and <a href="https://developers.tiktok.com/doc/app-review-guidelines" target="_blank" rel="noopener noreferrer">TikTok’s app review guidelines</a>.</p>
        <h3>6. Record the real end-to-end demo</h3>
        <p className="setup-help">On Windows 11, open <strong>Snipping Tool</strong>, choose <strong>Record</strong> (the video camera), then <strong>New</strong>. Select the browser area including the address bar and click <strong>Start</strong>. Complete the steps below, click <strong>Stop</strong>, then save the MP4. If your version has no Record option, use another recorder that exports MP4 or MOV.</p>
        <ol className="review-recording-steps">{recordingSteps.map((step) => <li key={step}>{step}</li>)}</ol>
        <p className="setup-help">Use your real sandbox and account interactions. A sample walkthrough or test using simulated TikTok responses cannot replace TikTok’s required demonstration. Check that every selected product and scope is visible in your recording.</p>
        <DemoFiles />
      </div>}
    </section>
  );
}
