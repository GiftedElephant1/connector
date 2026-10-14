import { useEffect, useId, useState, type FormEvent } from "react";
import type { ApiRequest } from "./Setup";

type Installation = {
  version: string;
  updateGuideUrl: string;
  downloadUrl: string;
  preservesConnections: boolean;
};

export function ConnectorUpdates({ request }: { request: ApiRequest }) {
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [platform, setPlatform] = useState("");
  const [actions, setActions] = useState("");
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const id = useId();

  useEffect(() => {
    let active = true;
    setError("");
    request<Installation>("/api/installation")
      .then((result) => {
        if (active) setInstallation(result);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load installation details. Please try again.",
          );
      });
    return () => {
      active = false;
    };
  }, [request, attempt]);

  function prepare(event: FormEvent) {
    event.preventDefault();
    if (!platform.trim() || !actions.trim()) return;
    setDraft(
      `Please add an official API connector for ${platform.trim()} to GiftedElephant1/connector.\n\n` +
        `I need these actions: ${actions.trim()}\n\n` +
        "Please preserve my existing connected accounts, credentials, scheduled jobs, and AI connector configuration when updating the app.",
    );
    setCopied(false);
    setCopyError("");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError("Select the request below and copy it manually.");
    }
  }

  function resetDraft() {
    setDraft("");
    setCopied(false);
    setCopyError("");
  }

  return (
    <section className="setup-panel connector-updates" aria-labelledby={`${id}-title`}>
      <div className="setup-panel-heading">
        <div>
          <div className="eyebrow">ROOM TO GROW</div>
          <h2 id={`${id}-title`}>Updates and new connectors</h2>
        </div>
        {installation && (
          <span className="setup-status">Installed version {installation.version}</span>
        )}
      </div>
      <p className="setup-description">
        Add future connectors through an app update. The Windows update wizard
        keeps your existing accounts, saved settings, API keys, and scheduled jobs
        in your current installation.
      </p>
      {!installation && !error && <p role="status">Loading installation details…</p>}
      {error && (
        <div className="updates-error">
          <p className="inline-error" role="alert">{error}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry installation details
          </button>
        </div>
      )}
      {installation && (
        <>
          <div className="setup-button-row">
            <a
              className="button button-primary"
              href={installation.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View Windows releases ↗
            </a>
            <a
              className="button button-secondary"
              href={installation.updateGuideUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open update guide ↗
            </a>
          </div>
          <ol className="setup-instructions update-steps">
            <li>
              <strong>Choose a signed Windows release</strong>
              <p>On the releases page, choose Connector-Windows.zip from a signed release. If none is published yet, keep your current installation. After downloading, right-click the ZIP and choose Extract All.</p>
            </li>
            <li>
              <strong>Stop Connector, then open Update Connector</strong>
              <p>
                Right-click Connector’s icon beside the Windows clock and choose Stop Connector. In the new folder,
                double-click <strong>Update Connector.vbs</strong> and select your
                existing Connector folder when prompted.
              </p>
            </li>
            <li>
              <strong>Reopen your original installation</strong>
              <p>
                When the update finishes, open <strong>Start Connector</strong> in
                your original folder. Authorize any new connector once using
                Connect account.
              </p>
            </li>
          </ol>
          <p className="setup-help">
            Existing accounts stay saved. A platform can still ask you to sign in
            again if access expires, is revoked, or needs additional permissions.
          </p>
        </>
      )}
      <details className="setup-advanced connector-request">
        <summary>Request another connector</summary>
        <p className="setup-help">
          Prepare a request to paste into your Codex chat. Adding a platform
          requires an official API integration and an app update. This form
          prepares text locally; it does not send a request.
        </p>
        <form className="setup-form" onSubmit={prepare}>
          <label htmlFor={`${id}-platform`}>Platform name</label>
          <input
            id={`${id}-platform`}
            value={platform}
            onChange={(event) => {
              setPlatform(event.target.value);
              resetDraft();
            }}
            placeholder="For example, Slack"
            maxLength={120}
            required
          />
          <label htmlFor={`${id}-actions`}>What should the connector do?</label>
          <textarea
            id={`${id}-actions`}
            value={actions}
            onChange={(event) => {
              setActions(event.target.value);
              resetDraft();
            }}
            placeholder="For example, send messages and read replies"
            rows={3}
            maxLength={2000}
            required
            aria-describedby={`${id}-request-help`}
          />
          <p className="setup-help" id={`${id}-request-help`}>
            Describe the platform and actions. Keep passwords, tokens, and account
            details out of this request.
          </p>
          <button
            className="button button-secondary"
            type="submit"
            disabled={!platform.trim() || !actions.trim()}
          >
            Prepare connector request
          </button>
          {draft && (
            <div className="connector-request-result">
              <label htmlFor={`${id}-draft`}>Your connector request</label>
              <textarea
                id={`${id}-draft`}
                value={draft}
                readOnly
                rows={7}
                onFocus={(event) => event.target.select()}
              />
              <div className="setup-button-row">
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => void copy()}
                >
                  Copy connector request
                </button>
                <span className="setup-help" role="status">
                  {copied ? "Copied. Paste this into your Codex chat." : ""}
                </span>
              </div>
              {copyError && <p className="setup-help" role="status">{copyError}</p>}
            </div>
          )}
        </form>
      </details>
    </section>
  );
}
