import { useEffect, useId, useState, type FormEvent } from "react";
import type { Provider } from "./App";
import { ConnectorUpdates } from "./Updates";
import { TikTokReview } from "./TikTokReview";
import { XSetup } from "./XSetup";
import { LinkedInSetup } from "./LinkedInSetup";
import "./setup.css";

export type ApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
export type SettingField = {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  value?: string;
  help?: string;
  options?: string[];
  providerIds: string[];
  required?: boolean;
};
export type WorkspaceSettings = {
  origin: string;
  localOrigin?: string;
  passwordConfigured: boolean;
  pipelineConfigured: boolean;
  fields: SettingField[];
};
type ProviderSettings = {
  id: string;
  name: string;
  fields: SettingField[];
  docsUrl: string;
  setupUrl: string;
  callbackUrl?: string;
};
type TunnelState = {
  available?: boolean;
  status: string;
  url?: string;
  configured: boolean;
  domain?: string;
  error?: string;
};
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";

export function CopyValue({
  value,
  label,
  secret = false,
}: {
  value: string;
  label: string;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  const id = useId();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setError("");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(
        "Copy is unavailable here. Select the field and copy it manually.",
      );
      setVisible(true);
    }
  }
  return (
    <div className="copy-value">
      <label htmlFor={id}>{label}</label>
      <div className="copy-row">
        <input
          id={id}
          value={value}
          type={secret && !visible ? "password" : "text"}
          readOnly
          autoComplete="off"
          onFocus={(event) => event.target.select()}
        />
        {secret && (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setVisible(!visible)}
          >
            {visible ? "Hide" : "Show"}
          </button>
        )}
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      {error && (
        <p className="setup-help" role="status">
          {error}
        </p>
      )}
      <span className="sr-only" role="status">
        {copied ? `${label} copied` : ""}
      </span>
    </div>
  );
}

export function PasswordSetup({
  request,
  onSaved,
  initial = false,
}: {
  request: ApiRequest;
  onSaved: () => void;
  initial?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  async function save(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("The two passwords don’t match. Please enter them again.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request("/api/settings/password", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      setConfirm("");
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={initial ? "first-setup setup-panel" : "setup-panel"}>
      <div className="setup-panel-symbol" aria-hidden="true">
        ✦
      </div>
      <div className="eyebrow">
        {initial ? "WELCOME TO CONNECTOR" : "WORKSPACE SECURITY"}
      </div>
      <h2>
        {initial
          ? "First, make this workspace yours."
          : "Change your workspace password"}
      </h2>
      <p className="setup-description">
        {initial
          ? "Choose a password you can remember. You’ll use it when you open your workspace from another browser or your public address."
          : "Your new password takes effect immediately. Other browser sessions will be signed out."}
      </p>
      <form onSubmit={save} className="setup-form">
        <label htmlFor={`${id}-password`}>Choose a password</label>
        <input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={12}
          required
          disabled={busy}
        />
        <p className="setup-help">
          Use at least 12 characters. A few memorable words work well.
        </p>
        <label htmlFor={`${id}-confirm`}>Repeat your password</label>
        <input
          id={`${id}-confirm`}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          minLength={12}
          required
          disabled={busy}
        />
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="setup-notice" role="status">
            Your workspace password has been updated.
          </p>
        )}
        <button
          className="button button-primary"
          type="submit"
          disabled={busy || password.length < 12 || !confirm}
        >
          {busy
            ? "Saving…"
            : initial
              ? "Save password and continue"
              : "Save new password"}
        </button>
      </form>
    </section>
  );
}

export function SetupChecklist({
  settings,
  connected,
  onSettings,
  onAgents,
}: {
  settings: WorkspaceSettings | null;
  connected: number;
  onSettings: () => void;
  onAgents: () => void;
}) {
  const publicReady = !!settings?.origin.startsWith("https://");
  return (
    <section className="setup-checklist" aria-label="Getting started">
      <div className="checklist-intro">
        <span className="eyebrow">START HERE</span>
        <h2>Your connections, without the command line.</h2>
        <p>
          Set up your address once, choose your accounts, then give your AI
          agent access.
        </p>
      </div>
      <div className="checklist-steps">
        <button onClick={onSettings}>
          <span className={`step-number ${publicReady ? "done" : ""}`}>
            {publicReady ? "✓" : "1"}
          </span>
          <span>
            <strong>Set up your public address</strong>
            <small>
              {publicReady
                ? "HTTPS address configured"
                : "A guided setup for remote access"}
            </small>
          </span>
          <span aria-hidden="true">→</span>
        </button>
        <a href="#platforms-title">
          <span className={`step-number ${connected ? "done" : ""}`}>
            {connected ? "✓" : "2"}
          </span>
          <span>
            <strong>Connect your accounts</strong>
            <small>
              {connected
                ? `${connected} account${connected === 1 ? "" : "s"} connected`
                : "Choose any platform below"}
            </small>
          </span>
          <span aria-hidden="true">↓</span>
        </a>
        <button onClick={onAgents}>
          <span className="step-number">3</span>
          <span>
            <strong>Connect your AI agent</strong>
            <small>Use your existing Claude, ChatGPT, or Grok app</small>
          </span>
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  );
}

export function ProviderSetup({
  provider,
  request,
  onSaved,
  onCancel,
  onReset,
}: {
  provider: Provider;
  request: ApiRequest;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onReset: () => void;
}) {
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  useEffect(() => {
    let active = true;
    request<ProviderSettings>(
      `/api/settings/providers/${encodeURIComponent(provider.id)}`,
    )
      .then((result) => {
        if (active) setSettings(result);
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [provider.id, request]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ values }),
      });
      setValues({});
      await onSaved();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="provider-setup">
      <p className="dialog-copy">
        {provider.authType === "link"
          ? "Connect a bank through Plaid’s secure account picker. First, add your Plaid application details below."
          : `Give Connector permission to connect to ${provider.name}. Add these application details once; future connections use the platform’s sign-in screen.`}
      </p>
      {provider.id === "tiktok" && <p className="setup-help">New to TikTok for Developers? Open Prepare TikTok submission below for the full account-registration, web-app creation, sandbox, and connection instructions, including every application field.</p>}
      {provider.id === "tiktok" && <TikTokReview request={request} />}
      {provider.id === "x" && <XSetup request={request} />}
      {!settings && !error && <p role="status">Loading connection setup…</p>}
      {settings && (
        <form onSubmit={save} className="setup-form">
          <ol className="setup-instructions">
            <li>
              <strong>Open your developer account</strong>
              <p>
                Sign in, create or select an application, and find its
                credentials. Some platforms require business verification or API
                approval before you can continue.
              </p>
              <a
                className="button button-secondary"
                href={settings.setupUrl || settings.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open {provider.name} developer portal ↗
              </a>
            </li>
            {settings.callbackUrl && (
              <li>
                {provider.id === "linkedin" || provider.id === "linkedin-ads" ? <LinkedInSetup callbackUrl={settings.callbackUrl} clientId={values.LINKEDIN_CLIENT_ID ?? settings.fields.find(field => field.key === "LINKEDIN_CLIENT_ID")?.value ?? ""} /> : <>
                <strong>Add this redirect address</strong>
                <p>
                  In the developer portal’s OAuth or redirect settings, paste
                  this exact address and save it.
                </p>
                <CopyValue
                  label="Redirect address"
                  value={settings.callbackUrl}
                />
                </>}
              </li>
            )}
            <li>
              <strong>Paste your application details</strong>
              <p>
                Copy each value from your developer portal and paste it below.
                Saved credentials stay encrypted.
              </p>
            </li>
          </ol>
          <div className="setup-fields">
            {settings.fields.map((field) => (
              <div className="setup-field" key={field.key}>
                <label htmlFor={`${id}-${field.key}`}>
                  {field.label}
                  {field.configured && (
                    <span className="saved-label">Saved ✓</span>
                  )}
                </label>
                {field.options ? (
                  <select
                    id={`${id}-${field.key}`}
                    value={values[field.key] ?? field.value ?? field.options[0]}
                    onChange={(event) =>
                      setValues((previous) => ({
                        ...previous,
                        [field.key]: event.target.value,
                      }))
                    }
                    disabled={busy}
                  >
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {option === "sandbox"
                          ? "Sandbox — test bank data"
                          : option === "production"
                            ? "Production — real bank data"
                            : option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`${id}-${field.key}`}
                    type={field.secret ? "password" : "text"}
                    value={
                      values[field.key] ??
                      (field.secret ? "" : field.value) ??
                      ""
                    }
                    onChange={(event) =>
                      setValues((previous) => ({
                        ...previous,
                        [field.key]: event.target.value,
                      }))
                    }
                    placeholder={
                      field.secret && field.configured
                        ? "Already saved — leave blank to keep"
                        : `Paste ${field.label.toLowerCase()}`
                    }
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    required={field.required && !field.configured}
                  />
                )}
                {field.help && <p className="setup-help">{field.help}</p>}
              </div>
            ))}
          </div>
          {provider.id === "plaid" && (
            <div className="info-note">
              <p>
                Sandbox connects test banks. Real bank data requires approved
                Plaid production access. Your bank password is entered in Plaid
                or your bank’s screen. Connected bank data is read-only and
                becomes available to AI assistants you authorize with your
                Connector API key.
              </p>
            </div>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={busy}
            >
              {busy ? "Saving…" : "Save and continue"}
            </button>
          </div>
          <p className="setup-help">
            Changes take effect immediately. You don’t need to restart
            Connector.
          </p>
        </form>
      )}
      {!settings && error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="button button-danger-subtle connector-reset-trigger" onClick={onReset} disabled={busy}>Disable and reset</button>
    </div>
  );
}

export function WorkspaceSetup({
  settings,
  providers,
  request,
  onRefresh,
  onConfigure,
  onReset,
  onPasswordSaved,
}: {
  settings: WorkspaceSettings;
  providers: Provider[];
  request: ApiRequest;
  onRefresh: () => Promise<void>;
  onConfigure: (provider: Provider) => void;
  onReset: (provider: Provider) => void;
  onPasswordSaved: () => void;
}) {
  const [tunnel, setTunnel] = useState<TunnelState | null>(null);
  const [token, setToken] = useState("");
  const [domain, setDomain] = useState("");
  const [origin, setOrigin] = useState(settings.origin);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const id = useId();
  const currentIsPublic = settings.origin.startsWith("https://");
  const differentOrigin = window.location.origin !== settings.origin;
  useEffect(() => {
    setOrigin(settings.origin);
  }, [settings.origin]);
  useEffect(() => {
    let active = true;
    let initial = true;
    async function refresh() {
      try {
        const result = await request<TunnelState>("/api/tunnel");
        if (active) {
          setTunnel(result);
          if (initial) {
            setDomain(result.domain || "");
            initial = false;
          }
        }
      } catch (cause) {
        if (active) setError(message(cause));
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [request]);
  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy("start");
    setError("");
    setNotice("");
    try {
      setTunnel(
        await request<TunnelState>("/api/tunnel/start", {
          method: "POST",
          body: JSON.stringify({
            ...(token.trim() ? { authtoken: token.trim() } : {}),
            ...(domain.trim() ? { domain: domain.trim() } : {}),
          }),
        }),
      );
      setToken("");
      await onRefresh();
      setNotice(
        "Your public address is ready. Open it below and sign in with your workspace password before connecting accounts.",
      );
    } catch (cause) {
      setError(message(cause));
      try {
        setTunnel(await request<TunnelState>("/api/tunnel"));
      } catch {
        /* Preserve the original start error. */
      }
    } finally {
      setBusy("");
    }
  }
  async function stop() {
    setBusy("stop");
    setError("");
    setNotice("");
    try {
      setTunnel(
        await request<TunnelState>("/api/tunnel/stop", { method: "POST" }),
      );
      await onRefresh();
      setNotice(
        "Public access stopped. Hosted agents cannot reach Connector until you start it again.",
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  }
  async function saveOrigin(event: FormEvent) {
    event.preventDefault();
    setBusy("origin");
    setError("");
    try {
      await request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ values: { APP_ORIGIN: origin } }),
      });
      await onRefresh();
      setNotice(
        "Public address saved. Use that address for account sign-in and update any existing platform redirects if it changed.",
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="workspace-setup">
      <section className="page-heading">
        <div>
          <div className="eyebrow">EVERYTHING IN ONE PLACE</div>
          <h1>
            Workspace setup<span>.</span>
          </h1>
          <p>Manage your updates, address, platform credentials, and password here.</p>
        </div>
      </section>
      <ConnectorUpdates request={request} />
      <section className="setup-panel" aria-labelledby="public-address-title">
        <div className="setup-panel-heading">
          <div>
            <h2 id="public-address-title">
              Make Connector available to your AI agent
            </h2>
            <p className="setup-description">
              Connector runs on your PC. A secure ngrok address lets your agent
              reach it over the internet.
            </p>
          </div>
          <span
            className={`setup-status ${tunnel?.status === "running" ? "ready" : ""}`}
          >
            {tunnel?.status === "running"
              ? "Public access is on"
              : "Public access"}
          </span>
        </div>
        <form className="setup-form" onSubmit={start}>
          <ol className="setup-instructions">
            <li>
              <strong>Get your ngrok token</strong>
              <p>
                Open the link below and sign in or create an ngrok account. On
                the “Your Authtoken” page, click the copy icon beside your
                token.
              </p>
              <a
                className="button button-secondary"
                href="https://dashboard.ngrok.com/get-started/your-authtoken"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open ngrok’s Your Authtoken page ↗
              </a>
            </li>
            <li>
              <strong>Paste the token and start your connection</strong>
              <p>
                Click the box below, press Ctrl+A to replace any old text,
                then Ctrl+V to paste. Click Start public access. Connector
                saves the token securely and starts the tunnel for you.
              </p>
              <p>
                You can also paste the full <code>ngrok config add-authtoken</code>{" "}
                line from the dashboard. Use your actual token, not{" "}
                <code>$YOUR_AUTHTOKEN</code>, hidden dots, an API key, or a
                website address. No terminal commands are needed.
              </p>
            </li>
          </ol>
          <label htmlFor={`${id}-ngrok`}>
            ngrok authentication token
            {tunnel?.configured && <span className="saved-label">Saved ✓</span>}
          </label>
          <input
            id={`${id}-ngrok`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={
              tunnel?.configured
                ? "Token saved — leave blank to reuse"
                : "Paste the token from Your Authtoken"
            }
            disabled={!!busy}
          />
          <details className="setup-advanced">
            <summary>Use an assigned ngrok domain (optional)</summary>
            <label htmlFor={`${id}-domain`}>Assigned domain</label>
            <input
              id={`${id}-domain`}
              placeholder="your-assigned-domain.ngrok-free.app"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              disabled={!!busy}
            />
            <p className="setup-help">
              Use a domain assigned to your ngrok account. A stable address
              avoids changing platform redirect settings.
            </p>
          </details>
          <div className="setup-button-row">
            <button
              type="submit"
              className="button button-primary"
              disabled={
                !!busy ||
                tunnel?.available === false ||
                !!tunnel?.url ||
                (!token.trim() && !tunnel?.configured)
              }
            >
              {busy === "start"
                ? "Starting public access…"
                : tunnel?.url
                  ? "Stop before starting again"
                  : "Start public access"}
            </button>
            {tunnel?.url && (
              <button
                className="button button-secondary"
                type="button"
                disabled={!!busy}
                onClick={() => void stop()}
              >
                {busy === "stop" ? "Stopping…" : "Stop public access"}
              </button>
            )}
          </div>
        </form>
        {tunnel?.available === false && (
          <p className="setup-help">
            Managed public access is unavailable in this environment. Use an
            existing HTTPS address below or open Connector with the desktop
            launcher.
          </p>
        )}
        {tunnel?.url && (
          <p className="setup-help">
            To change the token or domain, stop public access first.
          </p>
        )}
        {tunnel?.error && (
          <p className="inline-error" role="alert">
            {tunnel.error}
          </p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="setup-notice" role="status">
            {notice}
          </p>
        )}
        {currentIsPublic && (
          <div className="public-address-result">
            <CopyValue
              label="Your public workspace address"
              value={settings.origin}
            />
            <a
              className="button button-primary"
              href={settings.origin}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open public workspace ↗
            </a>
            <p className="setup-help">
              {differentOrigin
                ? "Sign in there with your workspace password, then connect your accounts from that page. The local and public addresses have separate browser sessions."
                : "You’re using the public workspace. Account sign-in will return to this address."}
            </p>
          </div>
        )}
        <p className="setup-help">
          Keep Connector running and your PC awake for remote access and
          scheduled posts.
        </p>
        <details className="setup-advanced">
          <summary>I already have an HTTPS address</summary>
          <form className="setup-form" onSubmit={saveOrigin}>
            <label htmlFor={`${id}-origin`}>Public workspace address</label>
            <input
              id={`${id}-origin`}
              type="url"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              required
            />
            <p className="setup-help">
              Enter the base address without /mcp. Saving an address does not
              deploy the app; it must already route to this Connector instance.
            </p>
            <button
              className="button button-secondary"
              disabled={!!busy}
              type="submit"
            >
              Save public address
            </button>
          </form>
        </details>
      </section>
      <TikTokReview request={request} origin={settings.origin} />
      <section className="setup-panel">
        <h2>Platform application settings</h2>
        <p className="setup-description">
          Add application credentials once. Then use Connect account to
          authorize each account. Your platform may require app review or paid
          API access.
        </p>
        <div className="settings-providers">
          {providers
            .filter(
              (provider) =>
                provider.category !== "ai" && ((provider.authType === "oauth" || provider.authType === "link") ||
                provider.missing.length > 0 ||
                settings.fields.some((field) =>
                  field.providerIds.includes(provider.id),
                )),
            )
            .map((provider) => (
              <div key={provider.id}>
                <span>
                  <strong>{provider.name}</strong>
                  <small>
                    {provider.configured
                      ? "Application ready"
                      : "Application details needed"}
                  </small>
                </span>
                <div className="settings-provider-actions"><button
                  className="button button-secondary"
                  onClick={() => onConfigure(provider)}
                >
                  Manage setup
                </button>
                <button className="button button-danger-subtle" onClick={() => onReset(provider)}>Disable and reset</button></div>
              </div>
            ))}
        </div>
      </section>
      <PasswordSetup request={request} onSaved={onPasswordSaved} />
    </div>
  );
}
