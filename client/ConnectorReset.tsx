import { useEffect, useState } from "react";
import type { ApiRequest } from "./Setup";
import "./connector-reset.css";

type ResetPreview = {
  provider: { id: string; name: string };
  affectedProviders: { id: string; name: string }[];
  clearsGoogleWorkspace: boolean;
  pendingJobs: number;
};
type ResetResult = { ok: true; warnings?: string[] };
const message = (cause: unknown) => cause instanceof Error ? cause.message : "Could not reset this connector. Please try again.";

/** Render inside the owner's confirmation dialog; opening this view never resets anything. */
export function ConnectorReset({ providerId, request, onCancel, onBusyChange, onReset, onSetUpAgain }: {
  providerId: string;
  request: ApiRequest;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
  onReset: () => Promise<void>;
  onSetUpAgain: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [result, setResult] = useState<ResetResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const endpoint = `/api/connections/${encodeURIComponent(providerId)}/reset`;

  useEffect(() => {
    let active = true;
    setPreview(null);
    setError("");
    request<ResetPreview>(endpoint).then(value => {
      if (active) setPreview(value);
    }).catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [endpoint, request, attempt]);

  async function reset() {
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const completed = await request<ResetResult>(endpoint, { method: "POST", body: JSON.stringify({ confirmed: true }) });
      setResult(completed);
      try { await onReset(); }
      catch { setError("The reset is complete, but the dashboard could not refresh. Set up again will retry loading your current settings."); }
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); onBusyChange(false); }
  }

  async function setUpAgain() {
    setBusy(true);
    onBusyChange(true);
    setError("");
    try { await onSetUpAgain(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); onBusyChange(false); }
  }

  return <div className="connector-reset">
    {result ? <>
      <p className="setup-notice" role="status">Reset complete. {preview?.provider.name || "This connector"} is disabled until you connect it again.</p>
      <p className="dialog-copy">Saved connection details have been removed. Choose Set up again to enter new details and authorize the account you want to use.</p>
      {!!result.warnings?.length && <div className="reset-warnings" role="alert"><strong>Additional step needed</strong><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    </> : preview ? <>
      <p className="dialog-copy">Start {preview.provider.name} from scratch by removing its saved connection and application settings.</p>
      <div className="reset-affected">
        <strong>{preview.affectedProviders.length > 1 || preview.clearsGoogleWorkspace ? "These connectors share application settings and will all be reset:" : "Connector to reset:"}</strong>
        <ul>{preview.affectedProviders.map(provider => <li key={provider.id}>{provider.id === "google-workspace" ? "Google Workspace — all connected Google accounts and app access" : provider.name}</li>)}{preview.clearsGoogleWorkspace && !preview.affectedProviders.some(provider => provider.id === "google-workspace") && <li>Google Workspace — all connected Google accounts and app access</li>}</ul>
      </div>
      <ul className="reset-effects">
        <li>Remove saved account tokens, application credentials, connection details, and pending sign-in attempts.</li>
        <li>Cancel scheduled work for these connectors{preview.pendingJobs > 0 ? ` (${preview.pendingJobs} pending ${preview.pendingJobs === 1 ? "job" : "jobs"})` : ""}. Requests already sent to a platform may still finish.</li>
        {preview.affectedProviders.some(provider => provider.id === "tiktok") && <li>Remove the uploaded TikTok domain verification file. Your app icon, Terms of Service, and Privacy Policy stay available.</li>}
        <li>Keep published content, existing activity history, local Obsidian notes, and connectors outside this group.</li>
      </ul>
      <p className="setup-help">This removes access through Connector. You may also need to revoke the app or token in the platform’s own account settings.</p>
    </> : !error && <p role="status">Checking which connections will be reset…</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="form-actions reset-actions">
      <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>{result ? "Done" : "Cancel"}</button>
      {result ? <button type="button" className="button button-primary" onClick={() => void setUpAgain()} disabled={busy}>{busy ? "Loading…" : "Set up again"}</button>
        : preview ? <button type="button" className="button button-danger" onClick={() => void reset()} disabled={busy}>{busy ? "Resetting…" : "Disable and reset"}</button>
          : error && <button type="button" className="button button-secondary" onClick={() => setAttempt(previous => previous + 1)}>Try again</button>}
    </div>
  </div>;
}
