import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { CopyValue, type ApiRequest } from "./Setup";
import "./workspace.css";

type WorkspaceApp = {
  id: string;
  name: string;
  description: string;
  available: boolean;
  auth: "oauth" | "api_key" | "unsupported";
  scopes: string[];
  docsUrl: string;
};
type GoogleAccount = {
  id: string;
  email: string;
  name: string;
  apps: string[];
  requestedApps: string[];
  missingApps: string[];
  connectedAt: string;
  mapsConfigured: boolean;
  status: string;
};
type Binding = { accountId: string; apps: string[] };
type AgentProfile = {
  id: string;
  name: string;
  bindings: Binding[];
  defaultAccountId?: string;
  createdAt: string;
  updatedAt: string;
};
type WorkspaceData = {
  apps: WorkspaceApp[];
  accounts: GoogleAccount[];
  profiles: AgentProfile[];
  google: { configured: boolean; missing: string[]; callbackUrl: string };
  mcpUrl: string;
};
type ProfileDraft = {
  id?: string;
  name: string;
  bindings: Binding[];
  defaultAccountId: string;
};
type PendingAction =
  | { kind: "account"; account: GoogleAccount }
  | { kind: "maps"; account: GoogleAccount }
  | { kind: "profile" | "rotate"; profile: AgentProfile }
  | null;
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "Could not complete this request. Please try again.";
const endpoint = "/api/workspace";

function permittedApps(account: GoogleAccount) {
  return new Set([
    ...account.apps,
    ...(account.mapsConfigured ? ["maps"] : []),
  ]);
}

export function GoogleWorkspace({
  api,
  onSettings,
  onAiConnections,
  onResetGoogleSetup,
}: {
  api: ApiRequest;
  onSettings?: () => void;
  onAiConnections?: () => void;
  onResetGoogleSetup?: () => void;
}) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [googleSetup, setGoogleSetup] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [connection, setConnection] = useState<{
    accountId?: string;
    apps: string[];
  } | null>(null);
  const [mapsAccount, setMapsAccount] = useState<string | null>(null);
  const [mapsKey, setMapsKey] = useState("");
  const [profile, setProfile] = useState<ProfileDraft | null>(null);
  const [issuedKey, setIssuedKey] = useState<{
    name: string;
    value: string;
  } | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const confirmation = useRef<HTMLElement>(null);
  const id = useId();

  const refresh = useCallback(async () => {
    const result = await api<WorkspaceData>(endpoint);
    setData(result);
    return result;
  }, [api]);
  useEffect(() => {
    let active = true;
    api<WorkspaceData>(endpoint)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    if (pending) {
      confirmation.current?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      confirmation.current?.focus();
    }
  }, [pending]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  function appNames(appIds: string[]) {
    return appIds
      .map((appId) => data?.apps.find((app) => app.id === appId)?.name || appId)
      .join(", ");
  }
  async function saveGoogle(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const values: Record<string, string> = {};
      if (clientId.trim()) values.GOOGLE_CLIENT_ID = clientId.trim();
      if (clientSecret.trim())
        values.GOOGLE_CLIENT_SECRET = clientSecret.trim();
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ values }),
      });
      setClientSecret("");
      setClientId("");
      await refresh();
      setGoogleSetup(false);
      setNotice(
        "Google application saved. You can now connect your Google accounts.",
      );
    });
  }
  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!connection) return;
    await run(async () => {
      const result = await api<{ url: string }>(`${endpoint}/google/start`, {
        method: "POST",
        body: JSON.stringify(connection),
      });
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.hostname !== "accounts.google.com")
        throw new Error(
          "Google returned an unexpected sign-in address. Please try again.",
        );
      window.location.assign(url.href);
    });
  }
  function changeBinding(accountId: string, appId: string, selected: boolean) {
    setProfile((current) => {
      if (!current) return current;
      const previous =
        current.bindings.find((binding) => binding.accountId === accountId)
          ?.apps || [];
      const apps = selected
        ? [...new Set([...previous, appId])]
        : previous.filter((value) => value !== appId);
      const bindings = current.bindings.filter(
        (binding) => binding.accountId !== accountId,
      );
      if (apps.length) bindings.push({ accountId, apps });
      const stillDefault = bindings.some(
        (binding) => binding.accountId === current.defaultAccountId,
      );
      return {
        ...current,
        bindings,
        defaultAccountId:
          stillDefault ||
          (!current.defaultAccountId && current.bindings.length > 0)
            ? current.defaultAccountId
            : bindings[0]?.accountId || "",
      };
    });
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    await run(async () => {
      const body = {
        name: profile.name.trim(),
        bindings: profile.bindings,
        defaultAccountId: profile.defaultAccountId || undefined,
      };
      const result = await api<{ profile: AgentProfile; apiKey?: string }>(
        `${endpoint}/profiles${profile.id ? `/${encodeURIComponent(profile.id)}` : ""}`,
        {
          method: profile.id ? "PUT" : "POST",
          body: JSON.stringify(body),
        },
      );
      if (result.apiKey)
        setIssuedKey({ name: result.profile.name, value: result.apiKey });
      setProfile(null);
      await refresh();
      setNotice(
        profile.id
          ? "Agent access updated. AI connections using this profile receive these permissions immediately."
          : "Agent profile created. Select it when approving your AI connection.",
      );
    });
  }
  async function confirmAction() {
    if (!pending) return;
    await run(async () => {
      if (pending.kind === "account") {
        await api(
          `${endpoint}/accounts/${encodeURIComponent(pending.account.id)}`,
          { method: "DELETE" },
        );
        setNotice(
          "Google account disabled and reset. Its saved tokens, Maps key, and agent permissions were removed. Use Connect Google account to start again, then assign agent access again.",
        );
        setConnection(null);
        setMapsAccount(null);
        setMapsKey("");
        setProfile(null);
      } else if (pending.kind === "maps") {
        await api(`${endpoint}/accounts/${encodeURIComponent(pending.account.id)}/maps-key`, { method: "DELETE" });
        setMapsAccount(null);
        setMapsKey("");
        setProfile(null);
        setNotice("Maps disabled and reset for this account. Its key and agent Maps permissions were removed. Use Connect Maps to start again.");
      } else if (pending.kind === "profile") {
        await api(
          `${endpoint}/profiles/${encodeURIComponent(pending.profile.id)}`,
          { method: "DELETE" },
        );
        setIssuedKey(null);
        setNotice(
          "Agent access removed. The Google accounts remain connected.",
        );
      } else {
        const result = await api<{ profile: AgentProfile; apiKey: string }>(
          `${endpoint}/profiles/${encodeURIComponent(pending.profile.id)}/rotate-key`,
          { method: "POST" },
        );
        setIssuedKey({ name: result.profile.name, value: result.apiKey });
        setNotice(
          "New key created. Replace the old key in this AI agent to restore its access.",
        );
      }
      setPending(null);
      await refresh();
    });
  }

  return (
    <div className="google-workspace">
      <header className="workspace-intro">
        <div className="eyebrow">THE RIGHT ACCOUNT FOR EACH AGENT</div>
        <h1>Google Workspace</h1>
        <p>
          Connect your Google accounts, then choose the accounts and apps each
          AI agent can use.
        </p>
      </header>
      {error && (
        <div className="workspace-feedback" role="alert">
          <p className="inline-error">{error}</p>
          {onSettings && (
            <button
              className="button button-secondary"
              type="button"
              onClick={onSettings}
            >
              Open connection settings
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className="workspace-notice" role="status">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status">Loading Google accounts and agent access…</p>
      )}
      {!loading && !data && (
        <button
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await refresh();
            })
          }
        >
          Retry Google Workspace
        </button>
      )}
      {data && (
        <>
          <section className="setup-panel" aria-labelledby={`${id}-setup`}>
            <div className="setup-panel-heading">
              <div>
                <div className="eyebrow">STEP 1 · ONCE FOR ALL ACCOUNTS</div>
                <h2 id={`${id}-setup`}>Google application setup</h2>
              </div>
              <span
                className={`setup-status ${data.google.configured ? "ready" : ""}`}
              >
                {data.google.configured
                  ? "Application ready"
                  : "Setup required"}
              </span>
            </div>
            <p className="setup-description">
              Add your Google application details once. Each account then
              connects through Google’s own sign-in screen. Your existing
              platform connections stay saved.
            </p>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setGoogleSetup(!googleSetup)}
            >
              {googleSetup ? "Hide Google setup" : "Manage Google setup"}
            </button>
            {onResetGoogleSetup && (
              <button
                type="button"
                className="button button-ghost"
                disabled={busy}
                onClick={onResetGoogleSetup}
              >
                Disable and reset Google setup
              </button>
            )}
            {(googleSetup || !data.google.configured) && (
              <form
                className="setup-form workspace-google-setup"
                onSubmit={saveGoogle}
              >
                <ol className="setup-instructions">
                  <li>
                    <strong>Create or choose your Google Cloud project</strong>
                    <p>
                      Open Google Cloud, use the project picker at the top, then
                      create a project or select your existing project.
                    </p>
                    <a
                      className="button button-secondary"
                      href="https://console.cloud.google.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open Google Cloud ↗
                    </a>
                  </li>
                  <li>
                    <strong>Enable the APIs you want to use</strong>
                    <p>
                      Open APIs &amp; Services → Library. Search for and enable
                      Google Sheets API, Google Docs API, Google Slides API,
                      Gmail API, Google Drive API, Google Meet API, Google Chat
                      API, and Tasks API as needed. Voice reporting uses the
                      Admin SDK API and requires a Google Workspace
                      administrator; it cannot send texts or make calls. Maps
                      has separate setup below.
                    </p>
                  </li>
                  <li>
                    <strong>Set up Google Auth Platform</strong>
                    <p>
                      Open Google Auth Platform → Branding and enter an app name
                      and support email. Under Audience, choose the appropriate
                      audience. While the app is in Testing, add every Google
                      account you want to connect as a test user. Under Data
                      Access, add the permissions for your selected apps. Google
                      may require verification for broader use; testing grants
                      can expire after seven days.
                    </p>
                  </li>
                  <li>
                    <strong>Create a web application client</strong>
                    <p>
                      Open Google Auth Platform → Clients → Create client.
                      Choose Web application. Under Authorized redirect URIs,
                      add this exact address and save. If you change Connector’s
                      public address, update this address in Google too.
                    </p>
                    <CopyValue
                      label="Google Workspace redirect address"
                      value={data.google.callbackUrl}
                    />
                  </li>
                  <li>
                    <strong>Paste your client ID and client secret</strong>
                    <p>
                      Open the client you just created, copy each value, then
                      paste it below. If Google only offers the secret when you
                      create the client, save it at that point. Saved
                      credentials stay encrypted.
                    </p>
                  </li>
                </ol>
                {data.google.configured && (
                  <p className="setup-help">
                    Your Google application is already configured. Leave fields
                    blank to keep the saved values. Changing to a different
                    Google application may require reconnecting its Google
                    accounts.
                  </p>
                )}
                <label htmlFor={`${id}-client`}>Google client ID</label>
                <input
                  id={`${id}-client`}
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  required={!data.google.configured}
                  autoComplete="off"
                  disabled={busy}
                  placeholder={
                    data.google.configured
                      ? "Already saved — leave blank to keep"
                      : "Paste your Google client ID"
                  }
                />
                <label htmlFor={`${id}-secret`}>Google client secret</label>
                <input
                  id={`${id}-secret`}
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  required={!data.google.configured}
                  autoComplete="off"
                  disabled={busy}
                  placeholder={
                    data.google.configured
                      ? "Already saved — leave blank to keep"
                      : "Paste your Google client secret"
                  }
                />
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={busy || (!clientId.trim() && !clientSecret.trim())}
                >
                  Save Google application
                </button>
              </form>
            )}
          </section>

          <section className="setup-panel" aria-labelledby={`${id}-accounts`}>
            <div className="setup-panel-heading">
              <div>
                <div className="eyebrow">
                  STEP 2 · CONNECT AS MANY AS YOU NEED
                </div>
                <h2 id={`${id}-accounts`}>Your Google accounts</h2>
              </div>
              <button
                className="button button-primary"
                type="button"
                disabled={busy || !data.google.configured}
                onClick={() => {
                  setConnection({ apps: [] });
                  setError("");
                }}
              >
                Connect Google account
              </button>
            </div>
            <p className="setup-description">
              Choose the apps to authorize for each account. Adding another
              account keeps the others connected. You’ll assign access to your
              agents in step 3.
            </p>
            {!data.accounts.length && (
              <p className="workspace-empty">
                No Google accounts connected yet.
              </p>
            )}
            <div className="workspace-accounts">
              {data.accounts.map((account) => (
                <article
                  className="workspace-account"
                  key={account.id}
                  aria-label={account.email}
                >
                  <div className="workspace-account-heading">
                    <div>
                      <h3>{account.email}</h3>
                      {account.name && <p>{account.name}</p>}
                    </div>
                    <span
                      className={`setup-status ${account.status === "connected" ? "ready" : ""}`}
                    >
                      {account.status === "connected"
                        ? "Connected"
                        : "Needs attention"}
                    </span>
                  </div>
                  <p className="workspace-app-summary">
                    {appNames([...permittedApps(account)]) ||
                      "No apps authorized"}
                  </p>
                  {account.missingApps.length > 0 && (
                    <p className="workspace-limited">
                      Permission still needed: {appNames(account.missingApps)}.
                      Select Change connected apps to approve access.
                    </p>
                  )}
                  <div className="setup-button-row">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() =>
                        setConnection({
                          accountId: account.id,
                          apps: [
                            ...new Set([
                              ...account.requestedApps,
                              ...account.apps,
                            ]),
                          ].filter((appId) =>
                            data.apps.some(
                              (app) =>
                                app.id === appId &&
                                app.auth === "oauth" &&
                                app.available,
                            ),
                          ),
                        })
                      }
                    >
                      Change connected apps
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() => {
                        setMapsAccount(
                          mapsAccount === account.id ? null : account.id,
                        );
                        setMapsKey("");
                      }}
                    >
                      {account.mapsConfigured
                        ? "Manage Maps key"
                        : "Connect Maps"}
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={busy}
                      onClick={() => setPending({ kind: "account", account })}
                    >
                      Disable and reset account
                    </button>
                  </div>
                  {mapsAccount === account.id && (
                    <form
                      className="setup-form workspace-maps"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void run(async () => {
                          await api(
                            `${endpoint}/accounts/${encodeURIComponent(account.id)}/maps-key`,
                            {
                              method: "PUT",
                              body: JSON.stringify({ apiKey: mapsKey.trim() }),
                            },
                          );
                          setMapsKey("");
                          setMapsAccount(null);
                          await refresh();
                          setNotice(
                            `Maps connected for ${account.email}. You can now assign Maps to an agent.`,
                          );
                        });
                      }}
                    >
                      <h4>Google Maps project key</h4>
                      <p className="setup-help">
                        Maps uses a Google Cloud project API key with billing
                        enabled. It searches public places and reads place
                        details; it does not access your personal saved places,
                        timeline, or location history.
                      </p>
                      <ol className="setup-instructions">
                        <li>
                          In your Google Cloud project, enable Places API (New).
                        </li>
                        <li>
                          Open APIs &amp; Services → Credentials → Create
                          credentials → API key. Restrict this key to Places API
                          (New). For a server key, use IP restrictions only if
                          your server has a stable public IP.
                        </li>
                        <li>
                          Copy the API key and paste it here. Connector stores
                          it encrypted and assigns it to this account for agent
                          access.
                        </li>
                      </ol>
                      <a
                        href="https://console.cloud.google.com/google/maps-apis/credentials"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open Maps credentials ↗
                      </a>
                      <label htmlFor={`${id}-maps`}>Maps API key</label>
                      <input
                        id={`${id}-maps`}
                        type="password"
                        autoComplete="off"
                        value={mapsKey}
                        onChange={(event) => setMapsKey(event.target.value)}
                        required
                        disabled={busy}
                        placeholder={
                          account.mapsConfigured
                            ? "Paste a replacement key"
                            : "Paste your Maps API key"
                        }
                      />
                      <div className="setup-button-row">
                        <button
                          type="submit"
                          className="button button-primary"
                          disabled={busy || !mapsKey.trim()}
                        >
                          Save Maps key
                        </button>
                        {account.mapsConfigured && (
                          <button
                            type="button"
                            className="button button-ghost"
                            disabled={busy}
                            onClick={() => setPending({ kind: "maps", account })}
                          >
                            Disable and reset Maps
                          </button>
                        )}
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={busy}
                          onClick={() => {
                            setMapsAccount(null);
                            setMapsKey("");
                          }}
                        >
                          Cancel Maps setup
                        </button>
                      </div>
                    </form>
                  )}
                </article>
              ))}
            </div>
            {connection && (
              <form
                className="workspace-editor setup-form"
                onSubmit={connect}
                aria-label="Choose Google apps"
              >
                <h3>
                  {connection.accountId
                    ? `Connected apps for ${data.accounts.find((account) => account.id === connection.accountId)?.email}`
                    : "Choose apps for your next Google account"}
                </h3>
                <p className="setup-help">
                  Select the apps you want this account to use, then approve
                  their permissions on Google. You can choose a different set
                  for each account. Removing an app from this selection does not
                  revoke existing Google permissions; use agent access below to
                  limit what each agent can use.
                </p>
                <div className="workspace-app-picker">
                  {data.apps.map((app) => (
                    <label
                      className={`workspace-app-option ${!app.available || app.auth !== "oauth" ? "unavailable" : ""}`}
                      key={app.id}
                    >
                      <input
                        type="checkbox"
                        checked={connection.apps.includes(app.id)}
                        disabled={
                          busy || !app.available || app.auth !== "oauth"
                        }
                        onChange={(event) =>
                          setConnection({
                            ...connection,
                            apps: event.target.checked
                              ? [...connection.apps, app.id]
                              : connection.apps.filter(
                                  (value) => value !== app.id,
                                ),
                          })
                        }
                      />
                      <span>
                        <strong>{app.name}</strong>
                        <small>
                          {app.description}
                          {app.auth === "api_key"
                            ? " Connect its project key after adding your account."
                            : ""}
                          {!app.available
                            ? " Not available through this connector."
                            : ""}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
                <details className="setup-advanced">
                  <summary>View requested Google permissions</summary>
                  <p className="setup-help">
                    Google displays these permissions during sign-in. Select
                    only the apps you need.
                  </p>
                  <ul className="workspace-scopes">
                    {[
                      ...new Set(
                        data.apps
                          .filter((app) => connection.apps.includes(app.id))
                          .flatMap((app) => app.scopes),
                      ),
                    ].map((scope) => (
                      <li key={scope}>
                        <code>{scope}</code>
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="setup-button-row">
                  <button
                    className="button button-primary"
                    type="submit"
                    disabled={busy || !connection.apps.length}
                  >
                    Continue to Google
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => setConnection(null)}
                  >
                    Cancel account connection
                  </button>
                </div>
              </form>
            )}
          </section>

          <section className="setup-panel" aria-labelledby={`${id}-agents`}>
            <div className="setup-panel-heading">
              <div>
                <div className="eyebrow">
                  STEP 3 · CHOOSE ACCESS FOR EACH AI AGENT
                </div>
                <h2 id={`${id}-agents`}>AI agent access</h2>
              </div>
              <button
                className="button button-primary"
                type="button"
                disabled={busy || !data.accounts.length}
                onClick={() => {
                  setProfile({ name: "", bindings: [], defaultAccountId: "" });
                  setIssuedKey(null);
                }}
              >
                Add AI agent
              </button>
            </div>
            <p className="setup-description">
              Give each AI its own profile, then select that profile when you
              approve access under AI connections. Each profile allows only the
              accounts and apps you select here. Multiple agents can share an
              account with different app permissions.
            </p>
            {!data.profiles.length && (
              <p className="workspace-empty">
                No agents have Google Workspace access yet.
              </p>
            )}
            <div className="workspace-profiles">
              {data.profiles.map((agent) => (
                <article
                  key={agent.id}
                  className="workspace-profile"
                  aria-label={`${agent.name} access`}
                >
                  <h3>{agent.name}</h3>
                  <ul className="workspace-bindings">
                    {agent.bindings.map((binding) => (
                      <li key={binding.accountId}>
                        <strong>
                          {data.accounts.find(
                            (account) => account.id === binding.accountId,
                          )?.email || "Account no longer connected"}
                        </strong>
                        {agent.defaultAccountId === binding.accountId && (
                          <span className="workspace-default">Default</span>
                        )}
                        <span>{appNames(binding.apps)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="setup-button-row">
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setProfile({
                          id: agent.id,
                          name: agent.name,
                          bindings: agent.bindings.map((binding) => ({
                            ...binding,
                            apps: [...binding.apps],
                          })),
                          defaultAccountId: agent.defaultAccountId || "",
                        });
                        setIssuedKey(null);
                      }}
                    >
                      Edit access
                    </button>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setPending({ kind: "rotate", profile: agent })
                      }
                    >
                      Replace connection key
                    </button>
                    <button
                      className="button button-ghost"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setPending({ kind: "profile", profile: agent })
                      }
                    >
                      Remove agent access
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {profile && (
              <form
                className="workspace-editor setup-form"
                aria-label="AI agent permissions"
                onSubmit={saveProfile}
              >
                <h3>
                  {profile.id ? "Edit agent access" : "Set up an AI agent"}
                </h3>
                <label htmlFor={`${id}-agent-name`}>Agent name</label>
                <input
                  id={`${id}-agent-name`}
                  value={profile.name}
                  onChange={(event) =>
                    setProfile({ ...profile, name: event.target.value })
                  }
                  placeholder="For example, Grok — work"
                  maxLength={100}
                  disabled={busy}
                  required
                />
                <p className="setup-help">
                  Select at least one app under each account this agent should
                  use. Leave every app unchecked to keep an account out of this
                  agent’s access.
                </p>
                {data.accounts.map((account) => (
                  <fieldset
                    className="workspace-permissions"
                    key={account.id}
                    disabled={busy}
                  >
                    <legend>{account.email}</legend>
                    <div className="workspace-permission-grid">
                      {data.apps.map((app) => {
                        const enabled =
                          app.available && permittedApps(account).has(app.id);
                        const checked = profile.bindings.some(
                          (binding) =>
                            binding.accountId === account.id &&
                            binding.apps.includes(app.id),
                        );
                        return (
                          <label
                            key={app.id}
                            className={enabled ? "" : "unavailable"}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!enabled && !checked}
                              onChange={(event) =>
                                changeBinding(
                                  account.id,
                                  app.id,
                                  event.target.checked,
                                )
                              }
                            />
                            <span>
                              {app.name}
                              {!enabled && (
                                <small>
                                  {app.id === "maps"
                                    ? "Connect a Maps key first"
                                    : "Connect this app first"}
                                </small>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
                <label htmlFor={`${id}-default`}>
                  Default Google account for this agent
                </label>
                <select
                  id={`${id}-default`}
                  value={profile.defaultAccountId}
                  onChange={(event) =>
                    setProfile({
                      ...profile,
                      defaultAccountId: event.target.value,
                    })
                  }
                  disabled={busy || !profile.bindings.length}
                >
                  <option value="">
                    No default — choose an account for every action
                  </option>
                  {profile.bindings.map((binding) => (
                    <option key={binding.accountId} value={binding.accountId}>
                      {data.accounts.find(
                        (account) => account.id === binding.accountId,
                      )?.email || binding.accountId}
                    </option>
                  ))}
                </select>
                <p className="setup-help">
                  The agent uses the default when you don’t name an account.
                  With no default, it must choose an account for every action.
                  You can ask it to use any other account allowed in this
                  profile. It cannot access accounts or apps outside this
                  selection.
                </p>
                <div className="setup-button-row">
                  <button
                    type="submit"
                    className="button button-primary"
                    disabled={
                      busy || !profile.name.trim() || !profile.bindings.length
                    }
                  >
                    {profile.id
                      ? "Save agent access"
                      : "Create agent connection"}
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => setProfile(null)}
                  >
                    Cancel agent setup
                  </button>
                </div>
              </form>
            )}
            {issuedKey && (
              <section
                className="workspace-key"
                aria-label={`${issuedKey.name} connection details`}
              >
                <h3>Connect {issuedKey.name}</h3>
                <p className="setup-help">
                  Open AI connections, add Connector in your AI app using OAuth,
                  and choose this Google Workspace profile on the approval
                  screen. This requires no AI developer account or API key.
                </p>
                {onAiConnections && <button className="button button-primary" type="button" onClick={onAiConnections}>Open AI connections</button>}
                <h4>Optional: a client that requires a Connector key</h4>
                <p className="setup-help">
                  The key below is created by Connector, not an AI provider. Use
                  it only if your client accepts key authentication instead of
                  OAuth. It is shown only after creation or replacement. Such
                  clients need a separate Google Workspace connector alongside
                  their standard-platform connector.
                </p>
                <CopyValue
                  label="Google Workspace connector URL"
                  value={data.mcpUrl}
                />
                <CopyValue
                  label="Agent connection key"
                  value={issuedKey.value}
                  secret
                />
                <p className="setup-help">
                  Use the key in the API key or Bearer token field. For clients
                  with custom headers, use Authorization: Bearer followed by a
                  space and the key. The agent must support a remote MCP
                  connector with token authentication.
                </p>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setIssuedKey(null)}
                >
                  I’ve saved these connection details
                </button>
              </section>
            )}
          </section>
          {pending && (
            <section
              className="workspace-confirm setup-panel"
              ref={confirmation}
              tabIndex={-1}
              role="alertdialog"
              aria-modal="false"
              aria-labelledby={`${id}-confirm`}
              aria-describedby={`${id}-confirm-description`}
            >
              <h2 id={`${id}-confirm`}>
                {pending.kind === "account"
                  ? `Disable and reset ${pending.account.email}?`
                  : pending.kind === "maps"
                    ? `Disable and reset Maps for ${pending.account.email}?`
                    : pending.kind === "profile"
                      ? `Remove ${pending.profile.name} access?`
                      : `Replace ${pending.profile.name} connection key?`}
              </h2>
              <p className="setup-description" id={`${id}-confirm-description`}>
                {pending.kind === "account"
                  ? "This removes the account’s saved sign-in tokens, Maps key, and all agent permissions for this account. Unfinished Google sign-ins will be cancelled. Other connected accounts and your shared Google app setup stay saved. To reconnect, choose Connect Google account and assign agent access again. Existing content in Google is not deleted; an action already sent to Google may still finish. This does not revoke permission in your Google account settings."
                  : pending.kind === "maps"
                    ? "This removes the saved Maps key and every agent’s Maps access for this account. Its other Google apps stay connected. Reconnecting Maps will require a key and assigning Maps to agents again. This does not delete the key from Google Cloud."
                    : pending.kind === "profile"
                      ? "This profile’s key and any AI authorization using this profile will stop working immediately. Your Google accounts and unrelated AI connections remain connected."
                      : "The previous key will stop working immediately. Replace it in clients using key authentication. OAuth AI connections and your Google accounts remain connected."}
              </p>
              <div className="setup-button-row">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy}
                  onClick={() => void confirmAction()}
                >
                  {pending.kind === "account"
                    ? "Confirm disable and reset account"
                    : pending.kind === "maps"
                      ? "Confirm disable and reset Maps"
                      : pending.kind === "profile"
                        ? "Confirm remove agent access"
                        : "Create replacement key"}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => setPending(null)}
                >
                  Cancel
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
