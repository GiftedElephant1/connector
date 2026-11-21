import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { BrowserCheck, BrowserChoice, BrowserSnapshot } from "../server/browser-types";
import type { ApiRequest } from "./Setup";
import "./managed-browser.css";

const endpoint = "/api/browser";
const sorted = (values: string[]) => [...new Set(values)].sort().join("\n");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Browser access could not be updated. Try again.";

export function ManagedBrowser({ request, refreshKey, onAuthError }: {
  request: ApiRequest;
  refreshKey: number;
  onAuthError?: (error: unknown) => void;
}) {
  const id = useId();
  const [data, setData] = useState<BrowserSnapshot | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [browser, setBrowser] = useState<BrowserChoice>("auto");
  const [principals, setPrincipals] = useState<string[]>([]);
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [check, setCheck] = useState<BrowserCheck | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const dirty = !!data && (enabled !== data.enabled || browser !== data.browser || sorted(principals) !== sorted(data.principals));
  const unavailable = principals.filter(principal => !data?.availablePrincipals.some(item => item.id === principal));
  const canSave = !!data && !busy && (!enabled || (data.onePasswordEnabled && principals.length > 0 && !unavailable.length));

  function snapshot(next: BrowserSnapshot) {
    setData(next); setEnabled(next.enabled); setBrowser(next.browser); setPrincipals(next.principals);
  }

  useEffect(() => {
    let active = true;
    setBusy("loading"); setError(""); setNotice(""); setCheck(null);
    request<BrowserSnapshot>(endpoint).then(result => {
      if (active) { snapshot(result); setBusy(""); }
    }).catch(cause => {
      if (active) { setError(errorMessage(cause)); setBusy(""); onAuthError?.(cause); }
    });
    return () => { active = false; };
  }, [request, refreshKey]);

  useEffect(() => {
    if (error) { feedback.current?.focus(); feedback.current?.scrollIntoView({ block: "nearest" }); }
  }, [error]);

  async function run(name: string, task: () => Promise<void>) {
    setBusy(name); setError(""); setNotice("");
    try { await task(); }
    catch (cause) { setError(errorMessage(cause)); onAuthError?.(cause); }
    finally { setBusy(""); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    await run("save", async () => {
      const next = await request<BrowserSnapshot>(endpoint, {
        method: "PUT", body: JSON.stringify({ enabled, browser, principals }),
      });
      snapshot(next); setCheck(null);
      setNotice(next.enabled
        ? "Browser access saved. Ask an allowed AI to use Connector’s browser and sign in with 1Password. No individual credential links are needed."
        : "Browser access is off. Connector’s managed browser windows have been closed.");
    });
  }

  function choosePrincipal(principal: string, checked: boolean) {
    setPrincipals(previous => checked ? [...new Set([...previous, principal])] : previous.filter(value => value !== principal));
  }

  return <section className="managed-browser-panel" aria-labelledby={`${id}-title`}>
    <div className="managed-browser-heading">
      <div><div className="eyebrow">LIVE LOGINS · ALL ACCESSIBLE VAULTS</div><h3 id={`${id}-title`}>Browser access for AI agents</h3></div>
      {data && <span className={`setup-status ${data.enabled && data.onePasswordEnabled ? "ready" : ""}`}>{data.enabled && data.onePasswordEnabled ? "Enabled" : data.enabled ? "Paused" : "Off"}</span>}
    </div>
    <p className="setup-description">Let your Bots use a dedicated browser window on this PC. At sign-in, Connector searches every vault your signed-in 1Password accounts can access and fills a matching login directly. No individual credential links are needed.</p>
    <p className="setup-help">This window has separate sessions from your existing browser tabs and Grok’s built-in browser. Password values are not included in Connector’s browser tool responses. Keep Connector running, approve 1Password requests when prompted, and complete any MFA in the browser.</p>
    <div ref={feedback} tabIndex={-1} className={`managed-browser-feedback${error ? " error" : ""}`} role={error ? "alert" : "status"}>
      {error || notice || (busy === "loading" ? "Loading browser access…" : "")}
    </div>
    {!data && !busy && <button className="button button-secondary" type="button" onClick={() => void run("loading", async () => { snapshot(await request<BrowserSnapshot>(endpoint)); })}>Retry browser setup</button>}
    {data && <>
      {!data.onePasswordEnabled && <p className="managed-browser-prerequisite">Enable <strong>1Password credential retrieval</strong> above and click <strong>Save 1Password setup</strong> before enabling browser access.</p>}
      <form className="setup-form managed-browser-form" onSubmit={save} aria-label="Browser access configuration">
        <label className="onepassword-checkbox"><input type="checkbox" checked={enabled} disabled={!!busy || (!data.onePasswordEnabled && !enabled)} onChange={event => setEnabled(event.currentTarget.checked)} />Enable browser access with live 1Password</label>
        <label htmlFor={`${id}-browser`}>Browser</label>
        <select id={`${id}-browser`} value={browser} disabled={!!busy} onChange={event => { setBrowser(event.currentTarget.value as BrowserChoice); setCheck(null); }}>
          <option value="auto">Automatically find an installed browser</option>
          <option value="edge">Microsoft Edge</option>
          <option value="chrome">Google Chrome</option>
          <option value="chromium">Chromium</option>
        </select>
        <p className="setup-help">Connector opens its own window using the selected installed browser.</p>
        <fieldset className="onepassword-agent-access" disabled={!!busy}>
          <legend>AI connections allowed to use this browser</legend>
          <p className="setup-help">Selected AI connections can use matching logins from all accessible vaults, then read and act in signed-in websites. Only select connections you trust with that access. New AI connections must be added here separately.</p>
          {data.availablePrincipals.length ? data.availablePrincipals.map(principal => <label key={principal.id} className="onepassword-checkbox">
            <input type="checkbox" checked={principals.includes(principal.id)} onChange={event => choosePrincipal(principal.id, event.currentTarget.checked)} />{principal.label}
          </label>) : <p className="setup-help">No eligible AI connections are available. Connect an AI app or configure your general Connector key first.</p>}
          {unavailable.map(principal => <label key={principal} className="onepassword-checkbox">
            <input type="checkbox" checked onChange={() => choosePrincipal(principal, false)} />Unavailable AI connection — uncheck to remove its saved access
          </label>)}
          <p className="setup-help">Bots sharing the same Connector key or AI connection also share its browser access and session. Selecting the shared Connector key allows every client holding that key.</p>
        </fieldset>
        {enabled && !principals.length && <p className="setup-help">Select at least one AI connection before saving browser access.</p>}
        <div className="setup-button-row">
          <button className="button button-primary" type="submit" disabled={!canSave}>{busy === "save" ? "Saving…" : "Save browser access"}</button>
          <button className="button button-secondary" type="button" disabled={!!busy || dirty} onClick={() => void run("check", async () => { setCheck(await request<BrowserCheck>(`${endpoint}/check`, { method: "POST", body: "{}" })); })}>{busy === "check" ? "Checking…" : "Check browser"}</button>
        </div>
        {dirty && <p className="setup-help">Save changes to apply browser access. Saving closes existing managed browser windows.</p>}
        {check && <p className="managed-browser-check" role="status">{check.message}</p>}
      </form>
      <div className="managed-browser-session-heading"><h4>Browser sessions</h4><button className="button button-secondary" type="button" disabled={!!busy || dirty} onClick={() => void run("refresh", async () => { snapshot(await request<BrowserSnapshot>(endpoint)); setNotice("Browser sessions refreshed."); })}>{busy === "refresh" ? "Refreshing…" : "Refresh browser sessions"}</button></div>
      {!data.sessions.length && <p className="setup-help">No managed browser windows are open. An allowed AI opens one when you ask it to use Connector’s browser.</p>}
      <div className="managed-browser-sessions">{data.sessions.map(session => <article key={session.id} className="managed-browser-session" aria-label={`${session.principalLabel} browser session`}>
        <h5>{session.principalLabel}</h5><p>{session.origin || "Waiting for a website"}</p><p className="setup-help">Last used: {new Date(session.lastUsedAt).toLocaleString()}</p>
      </article>)}</div>
      <div className="setup-button-row"><button className="button button-secondary" type="button" disabled={!!busy || !data.sessions.length} onClick={() => void run("close", async () => {
        const next = await request<BrowserSnapshot>(`${endpoint}/close-all`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
        // Closing windows must not discard pending permission changes.
        setData(next); setNotice("All Connector-managed browser windows have been closed.");
      })}>{busy === "close" ? "Closing…" : "Close all browser windows"}</button></div>
    </>}
  </section>;
}
