import { useCallback, useEffect, useId, useState } from "react";
import { CopyValue, type ApiRequest } from "./Setup";
import "./ai-connections.css";

type WorkspaceProfile = {
  id: string;
  name: string;
  bindings: { accountId: string; accountEmail?: string; apps: string[] }[];
  defaultAccountId?: string;
};
type AiGrant = {
  id: string;
  clientName: string;
  redirectUri?: string;
  createdAt: string;
  expiresAt?: string;
  platforms: boolean;
  workspaceProfileId?: string;
  workspaceProfileName?: string;
  lastUsedAt?: string;
};
type AiClient = { id: string; name: string; redirectUris: string[]; grants: number; pendingRequests: number };
type AiResetPreview = AiClient & { authorizationCodes: number; accessTokens: number; refreshTokens: number };
type AiConnectors = { url: string; grants: AiGrant[]; clients?: AiClient[] };
type ConsentRequest = {
  id: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  resource: string;
  expiresAt: string;
  workspaceProfiles: WorkspaceProfile[];
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The request could not be completed.";
const apps = [
  { name: "Claude", symbol: "✳", url: "https://claude.ai/settings/connectors", instructions: "Open Settings → Connectors → Add custom connector. Name it Connector, paste the Connector URL below, and add it. Select Connect if prompted, then sign in to Connector and review the access request.", note: "Use your existing Claude subscription. Custom connectors must be available on your plan." },
  { name: "ChatGPT", symbol: "✦", url: "https://chatgpt.com/", instructions: "Open Settings → Apps (or Connectors). If needed, enable Developer mode under Advanced settings. Choose Create app (or Create connector), enter the Connector URL below, and select OAuth authentication. Leave optional OAuth client ID and secret fields empty. Sign in to Connector and review the access request.", note: "Developer mode is a ChatGPT setting; it does not require an OpenAI API account. Availability depends on your plan and workspace administrator." },
  { name: "Grok Bot", symbol: "◇", url: "https://x.ai/news/introducing-grok-bot", instructions: "Open Grok Bot. If you have not installed it, use Download for Windows in xAI’s announcement below, sign in, and create your Bot. Copy the setup instructions below and send them to the Bot you want to use with Connector.", note: "Grok Bot has its own cloud computer. This setup asks it to connect through MCP; its supported connection methods and a live Grok Bot connection have not yet been verified. Opening the announcement does not connect your accounts." },
];

function GrokBotHandoff({ url, publicReady }: { url: string; publicReady: boolean }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const instructions = `Set up Connector for you, Grok Bot, to use as my account pipeline.

MCP server URL: ${url}
Transport: Streamable HTTP, not legacy SSE.

Use your supported custom MCP connection feature or MCP client on your cloud computer. Connector supports MCP OAuth discovery, dynamic client registration, and PKCE. Register this Bot separately so I can choose its access and revoke it independently. Ask me to complete sign-in and permission approval on Connector's authorization page. I will select standard platform tools and/or the Google Workspace agent profile this Bot may use.

If you support only a URL and secret HTTP headers, have me enter a Connector-generated key in your secure credential settings as Authorization: Bearer <key> or X-API-Key: <key>. The general key permits standard platforms only; Google Workspace uses a separate agent-profile key. Do not ask me to paste any key or password into chat or a URL.

Do not create an xAI, Anthropic, or OpenAI developer account or request their API keys. Do not start the optional npm run grok xAI API client. Keep my existing destination accounts connected. If your environment cannot use these connection methods, report exactly what is missing rather than claiming success.

After authorization, call list_connections for approved standard platforms and/or list_workspace_accounts for an approved Google profile. Show the actual tool result to verify the connection. Do not publish, send, edit, schedule, or delete anything during setup.

For later tasks, inspect list_actions or list_workspace_actions first. Before a write, obtain my authorization for its content, destination, timing, and any spend; use confirmed=true and a unique requestId, reusing that ID on retries. My PC must remain awake, online, and running Connector with public access on for your tools to work.`;
  async function copy() {
    setCopied(false); setCopyFailed(false);
    try { await navigator.clipboard.writeText(instructions); setCopied(true); }
    catch { setCopyFailed(true); }
  }
  return <div className="grok-bot-handoff">
    <p>Send these instructions to your chosen Bot. They contain your Connector address and setup steps, with no passwords or keys.</p>
    <button className="button button-primary" disabled={!publicReady} onClick={() => void copy()}>Copy instructions for Grok Bot</button>
    {copied && <p role="status">Copied. Paste the instructions into your Grok Bot conversation.</p>}
    {!publicReady && <p className="setup-help">Turn on public HTTPS access above before copying instructions.</p>}
    {publicReady && <details open={copyFailed || undefined}><summary>View instructions{copyFailed ? " — copying was unavailable; select and copy the text below" : ""}</summary><label htmlFor={`${id}-instructions`}>Setup message for Grok Bot</label><textarea id={`${id}-instructions`} readOnly rows={12} value={instructions} onFocus={event => event.currentTarget.select()} /></details>}
  </div>;
}

export function AiConnections({ request, onSettings, onAuthError }: {
  request: ApiRequest;
  onSettings?: () => void;
  onAuthError?: (error: unknown) => void;
}) {
  const [data, setData] = useState<AiConnectors | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("Claude");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AiGrant | null>(null);
  const [reset, setReset] = useState<AiResetPreview | null>(null);
  const [resetKey, setResetKey] = useState(false);
  const [key, setKey] = useState<{ apiKey: string; url: string; transport: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const load = useCallback(async () => {
    setError("");
    try { setData(await request<AiConnectors>("/api/ai/connectors")); }
    catch (cause) { setError(errorMessage(cause)); onAuthError?.(cause); }
  }, [request, onAuthError]);
  // Request uses the latest authentication handler without making re-renders refetch.
  useEffect(() => { void load(); }, [request]);
  const app = apps.find((item) => item.name === selected)!;
  const publicReady = data?.url.startsWith("https://");
  async function revealKey() {
    setBusy(true); setError("");
    try { setKey(await request("/api/settings/pipeline-key")); }
    catch (cause) { setError(errorMessage(cause)); onAuthError?.(cause); }
    finally { setBusy(false); }
  }
  async function revoke() {
    if (!pending) return;
    setBusy(true); setError("");
    try {
      await request(`/api/ai/connectors/${encodeURIComponent(pending.id)}`, { method: "DELETE" });
      setNotice(`Access revoked for ${pending.clientName}. Your platform accounts remain connected.`);
      setPending(null);
      await load();
    } catch (cause) { setError(errorMessage(cause)); onAuthError?.(cause); }
    finally { setBusy(false); }
  }
  async function previewReset(client: AiClient) {
    setBusy(true); setError(""); setNotice(""); setPending(null); setReset(null);
    try { setReset(await request<AiResetPreview>(`/api/ai/clients/${encodeURIComponent(client.id)}/reset`)); }
    catch (cause) { setError(errorMessage(cause)); onAuthError?.(cause); }
    finally { setBusy(false); }
  }
  async function resetClient() {
    if (!reset) return;
    setBusy(true); setError("");
    try {
      await request(`/api/ai/clients/${encodeURIComponent(reset.id)}/reset`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
      setNotice(`${reset.name} has been disabled and reset. Remove Connector in that AI app’s connector settings, then add it again using the Connector URL above. Approve a new access request to reconnect. Other AI connections and platform accounts remain connected. Jobs already queued must be cancelled separately in Schedule.`);
      setReset(null);
      await load();
    } catch (cause) { setError(errorMessage(cause)); onAuthError?.(cause); }
    finally { setBusy(false); }
  }
  async function resetSharedKey() {
    setBusy(true); setError(""); setKey(null);
    try {
      await request("/api/settings/pipeline-key/reset", { method: "POST", body: JSON.stringify({ confirmed: true }) });
      setResetKey(false);
      setNotice("The previous shared Connector API key is disabled. Show the new Connector API key below and replace the old key in each AI app you want to reconnect. OAuth connections and platform accounts are preserved. Jobs already queued must be cancelled separately in Schedule.");
    } catch (cause) { setError(errorMessage(cause)); onAuthError?.(cause); }
    finally { setBusy(false); }
  }
  return <section className="setup-panel ai-connections" aria-label="AI app connections">
    <div className="eyebrow">USE THE AI APPS YOU ALREADY HAVE</div>
    <h2>Claude, ChatGPT, and Grok Bot</h2>
    <p className="setup-description">Your AI app creates the content. Connector supplies tools for your connected accounts. Connector’s MCP tools do not need an Anthropic, OpenAI, or xAI developer API key. Your AI app must support the connection method.</p>
    <div className="ai-app-grid" role="group" aria-label="Choose your AI app">
      {apps.map((item) => <button key={item.name} className={`ai-app-card ${selected === item.name ? "selected" : ""}`} aria-pressed={selected === item.name} onClick={() => setSelected(item.name)}>
        <span className="ai-app-symbol" aria-hidden="true">{item.symbol}</span><strong>{item.name}</strong><span>Set up connection →</span>
      </button>)}
    </div>
    {!data && !error && <p role="status">Loading your connector address…</p>}
    {data && <>
      {!publicReady && <div className="ai-public-notice" role="status"><strong>First, turn on public access.</strong><p>These AI apps need a public HTTPS address to reach Connector on your PC. Keep Connector running while you use them.</p>{onSettings && <button className="button button-primary" onClick={onSettings}>Set up public address →</button>}</div>}
      <CopyValue label="Connector URL" value={data.url} />
      <div className="ai-setup-steps">
        <h3>Add Connector in {app.name}</h3>
        <ol><li>{app.instructions}</li><li>{app.name === "Grok Bot" ? "Follow the Bot’s supported connection flow. If it uses OAuth, sign in on Connector’s approval page and choose the platform access and Google Workspace profile this Bot may use. For a supported key-only connection, use the advanced Connector API key instructions below and enter the key only in secure credential settings." : "On Connector’s approval screen, choose your platform access and, optionally, a Google Workspace agent profile. Approve only the client and return address you recognize."}</li><li>{app.name === "Grok Bot" ? "After the Bot configures the connection, ask it: " : "After adding the connector in your AI app, enable it in a new chat and ask: "}<strong>“List my connected accounts. Do not publish or change anything.”</strong> A successful tool result verifies the connection.</li></ol>
        {app.name === "Grok Bot" && <GrokBotHandoff key={data.url} url={data.url} publicReady={Boolean(publicReady)} />}
        <p className="setup-help">{app.note}</p>
        <a className="button button-secondary" href={app.url} target="_blank" rel="noopener noreferrer">{app.name === "Grok Bot" ? "About Grok Bot" : `Open ${app.name}`} ↗</a>
        <p className="setup-help">Opening a link does not connect the AI app automatically. Your AI provider’s plan limits and connected platforms’ requirements still apply.</p>
      </div>
    </>}
    <div className="ai-grants">
      <div className="ai-section-heading"><h3>Approved AI connections</h3><button className="text-button" onClick={() => void load()} disabled={busy}>Refresh AI connections</button></div>
      {data && !data.grants.length && <p className="setup-help">No AI app has been approved yet. Approved connections appear here after you finish sign-in and grant access.</p>}
      {data?.grants.map((grant) => <article className="ai-grant" key={grant.id}>
        <div><h4>{grant.clientName}</h4><p>Approved {new Date(grant.createdAt).toLocaleDateString()}. Client name supplied by the requesting app.</p><p className="ai-grant-verification">{grant.lastUsedAt ? `Last successful tool call: ${new Date(grant.lastUsedAt).toLocaleString()}` : "Approved; waiting for the first successful tool call."}</p>{grant.expiresAt && <p>Authorization expires {new Date(grant.expiresAt).toLocaleString()}.</p>}{grant.redirectUri && <p className="ai-return-address">Return address: <code>{grant.redirectUri}</code></p>}<p>{grant.platforms ? "Standard platform tools enabled" : "Standard platform tools disabled"}{grant.workspaceProfileId ? ` · Google profile: ${grant.workspaceProfileName || grant.workspaceProfileId}` : " · No Google Workspace access"}</p></div>
        <button className="button button-secondary" onClick={() => { setPending(grant); setReset(null); setNotice(""); }} disabled={busy}>Revoke access for {grant.clientName}</button>
      </article>)}
      {pending && <div className="ai-revoke" role="group" aria-label="Confirm revoke access"><p>Revoke <strong>{pending.clientName}</strong>’s access? Its authorization will stop working. Your connected platform accounts and other AI connections are preserved. Jobs already scheduled will still run; cancel them separately in Schedule if needed.</p><button className="button button-secondary" onClick={() => setPending(null)} disabled={busy}>Keep access</button><button className="button button-danger" onClick={() => void revoke()} disabled={busy}>{busy ? "Revoking…" : "Confirm revoke access"}</button></div>}
    </div>
    <div className="ai-client-registrations">
      <h3>Disable an AI connection and start over</h3>
      <p className="setup-help">These are individual registrations sent by AI apps, including connections that have not finished setup. Names are supplied by the requesting app; check the return addresses and registration ID before resetting. If one AI app has several registrations, reset each one you want to remove.</p>
      {data && !data.clients?.length && <p className="setup-help">No AI client registrations to reset. Start a connection from your AI app using the instructions above.</p>}
      {data?.clients?.map((client) => <article className="ai-grant ai-client" key={client.id}>
        <div><h4>{client.name}</h4><p>{client.grants} approved connection(s) · {client.pendingRequests} pending request(s)</p><p>Registration ID: <code>{client.id}</code></p>{client.redirectUris.map(uri => <p className="ai-return-address" key={uri}>Return address: <code>{uri}</code></p>)}</div>
        <button className="button button-secondary" onClick={() => void previewReset(client)} disabled={busy}>Disable and reset {client.name}</button>
      </article>)}
      {reset && <div className="ai-revoke" role="group" aria-label="Confirm AI connection reset">
        <h4>Disable and reset {reset.name}?</h4>
        <p className="ai-return-address">Registration ID: <code>{reset.id}</code></p>
        {reset.redirectUris.map(uri => <p className="ai-return-address" key={uri}>Return address: <code>{uri}</code></p>)}
        <p>This removes this registration, {reset.grants} approved connection(s), {reset.pendingRequests} pending request(s), and all its authorization codes, access tokens, and refresh tokens. It stops future access through this registration.</p>
        <p>Jobs already queued will still run; cancel them in Schedule if needed. Actions already running may finish. Your connected platform accounts, Google profiles, other AI registrations, and shared Connector API key are preserved.</p>
        <p>To start over, remove Connector in this AI app’s connector settings, add it again using the Connector URL above, and approve a new access request.</p>
        <button className="button button-secondary" onClick={() => setReset(null)} disabled={busy}>Keep AI connection</button>
        <button className="button button-danger" onClick={() => void resetClient()} disabled={busy}>{busy ? "Resetting…" : "Confirm disable and reset AI connection"}</button>
      </div>}
    </div>
    {notice && <p className="setup-notice" role="status">{notice}</p>}
    {error && <div className="inline-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void load()}>Retry AI connection details</button></div>}
    <details className="setup-advanced" open={advanced} onToggle={(event) => { const open = event.currentTarget.open; setAdvanced(open); if (!open) setKey(null); }}>
      <summary>Advanced: connect with a Connector API key</summary>
      <p className="setup-help">Use this only when your MCP client requests an API key instead of OAuth. This key is created by Connector and does not require an AI developer account. It gives access to all standard platform tools; it does not grant Google Workspace access. Keep it out of chats.</p>
      {!key ? <button className="button button-secondary" onClick={() => void revealKey()} disabled={busy}>{busy ? "Loading…" : "Show Connector API key"}</button> : <><CopyValue label="Connector API key" value={key.apiKey} secret /><p className="setup-help">Transport: {key.transport}. Use an Authorization header with “Bearer ” followed by this key.</p><button className="text-button" onClick={() => setKey(null)}>Hide Connector API key</button></>}
      <p><button className="button button-secondary" onClick={() => { setResetKey(true); setNotice(""); }} disabled={busy}>Disable and reset shared API key</button></p>
      {resetKey && <div className="ai-revoke" role="group" aria-label="Confirm shared API key reset">
        <p>Disable the shared Connector API key and create a new one? Every AI client using the old key loses access. You will need to enter the new key in each AI app you want to reconnect. OAuth connections, Google profiles, and connected platform accounts are preserved.</p>
        <p>Jobs already queued will still run; cancel them separately in Schedule if needed. Actions already running may finish.</p>
        <button className="button button-secondary" onClick={() => setResetKey(false)} disabled={busy}>Keep shared API key</button>
        <button className="button button-danger" onClick={() => void resetSharedKey()} disabled={busy}>{busy ? "Resetting…" : "Confirm disable and reset shared API key"}</button>
      </div>}
    </details>
  </section>;
}

export function AiAuthorization({ requestId, request, onDone, onAuthError }: {
  requestId: string;
  request: ApiRequest;
  onDone: () => void;
  onAuthError: (error: unknown) => void;
}) {
  const [data, setData] = useState<ConsentRequest | null>(null);
  const [platforms, setPlatforms] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => {
    let active = true;
    void request<ConsentRequest>(`/api/ai/authorize/${encodeURIComponent(requestId)}`).then((result) => { if (active) setData(result); }).catch((cause) => { if (active) { setError(errorMessage(cause)); onAuthError(cause); } });
    return () => { active = false; };
  }, [requestId, request]);
  const profile = data?.workspaceProfiles.find((item) => item.id === profileId);
  async function respond(approve: boolean) {
    setBusy(true); setError("");
    try {
      const result = await request<{ redirectUrl: string }>(`/api/ai/authorize/${encodeURIComponent(requestId)}`, { method: "POST", body: JSON.stringify({ approve, platforms: approve && platforms, ...(approve && profileId ? { workspaceProfileId: profileId } : {}) }) });
      // The server validates and binds the return address to the original request.
      const target = new URL(result.redirectUrl);
      const registered = new URL(data!.redirectUri);
      if (target.origin !== registered.origin || target.pathname !== registered.pathname || !["https:", "http:"].includes(target.protocol)) throw new Error("The return address changed. Restart the connection from your AI app.");
      window.location.assign(target.href);
    } catch (cause) { setError(errorMessage(cause)); onAuthError(cause); setBusy(false); }
  }
  return <section className="setup-panel ai-authorization" aria-labelledby={`${id}-title`}>
    <div className="eyebrow">REVIEW AI APP ACCESS</div>
    <h1 id={`${id}-title`}>Authorize an AI connection</h1>
    {!data && !error && <p role="status">Loading the access request…</p>}
    {data && <>
      <p><strong>{data.clientName}</strong> is requesting access to your Connector tools.</p>
      <p className="setup-help">The requesting app supplies its name; the name alone does not verify its identity. Continue only if you just started this connection in your AI app and recognize the return address.</p>
      <dl className="ai-request-details"><dt>Return address</dt><dd><code>{data.redirectUri}</code></dd><dt>Connector being authorized</dt><dd><code>{data.resource}</code></dd><dt>Requested permission</dt><dd>{data.scope}</dd></dl>
      <fieldset className="ai-access-options" disabled={busy}><legend>Choose this AI connection’s access</legend>
        <label className="ai-access-check"><input type="checkbox" checked={platforms} onChange={(event) => setPlatforms(event.target.checked)} /><span><strong>Standard platform tools</strong><small>Access all standard accounts you connect now or later: social media, communications, ads, analytics, websites, banking, and Obsidian. This includes supported reading, writing, scheduling, and campaign actions. It excludes Google Workspace and AI developer API credentials.</small></span></label>
        <label htmlFor={`${id}-profile`}>Google Workspace agent profile</label>
        <select id={`${id}-profile`} value={profileId} onChange={(event) => setProfileId(event.target.value)}><option value="">No Google Workspace access</option>{data.workspaceProfiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        {!data.workspaceProfiles.length && <p className="setup-help">Create an agent profile in Google Workspace first if this AI should use Google accounts. Then restart this connection from your AI app.</p>}
        {profile && <div className="ai-profile-summary"><strong>Google access for {profile.name}</strong><ul>{profile.bindings.map((binding) => <li key={binding.accountId}><strong>{binding.accountEmail || binding.accountId}</strong><span>{binding.apps.join(", ")}</span>{profile.defaultAccountId === binding.accountId && <small>Default account</small>}</li>)}</ul><p className="setup-help">Only these accounts and apps are allowed. Changes you make to this profile also change this AI connection’s access.</p></div>}
      </fieldset>
      <p className="setup-help">Writes can publish content, send messages, or change data. Instruct your AI app to ask for approval before making changes. You can revoke this connection from AI connections at any time.</p>
      <div className="ai-consent-actions"><button className="button button-secondary" onClick={() => void respond(false)} disabled={busy}>Deny access</button><button className="button button-primary" onClick={() => void respond(true)} disabled={busy || (!platforms && !profileId)}>{busy ? "Continuing…" : "Approve selected access"}</button></div>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <button className="text-button" onClick={onDone} disabled={busy}>Return to Connector without approving</button>
  </section>;
}
