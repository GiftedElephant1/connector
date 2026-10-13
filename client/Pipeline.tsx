import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ActionResult } from "../server/action-types";
import type { Provider } from "./App";
import "./pipeline.css";
import { AiConnections } from "./AiConnections";

type ApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
type CommonProps = {
  providers: Provider[];
  request: ApiRequest;
  onAuthError: (error: unknown) => void;
};
type Job = {
  id: string;
  provider: string;
  action: string;
  scheduledAt: string;
  status:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "cancelled";
  createdAt: string;
  finishedAt?: string;
  result?: ActionResult;
  error?: string;
};

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The request could not be completed. Please try again.";
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}
function safeLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function Busy() {
  return <span className="spinner" aria-hidden="true" />;
}

function ReviewDialog({
  title,
  children,
  confirmLabel,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal action-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close review"
          disabled={busy}
        >
          ×
        </button>
      </div>
      <div className="modal-body">{children}</div>
      <div className="modal-footer">
        <button
          autoFocus
          className="button button-secondary"
          onClick={onClose}
          disabled={busy}
        >
          Go back
        </button>
        <button
          className="button button-primary"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? (
            <>
              <Busy /> Working…
            </>
          ) : (
            confirmLabel
          )}
        </button>
      </div>
    </dialog>
  );
}

function Results({ result }: { result: ActionResult }) {
  const columns = Array.from(
    new Set(result.items?.flatMap((item) => Object.keys(item)) || []),
  );
  const link = safeLink(result.link);
  return (
    <section className="workbench-result" aria-label="Operation result">
      <div className="result-heading">
        <div>
          <span className="eyebrow">RESULT</span>
          <h2>{result.summary}</h2>
        </div>
        {link && (
          <a
            className="text-link result-link"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in platform ↗
          </a>
        )}
      </div>
      {!!result.items?.length && (
        <div
          className="result-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="Result data"
        >
          <table className="result-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} scope="col">
                    {column.replace(/_/g, " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.items.map((item, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td key={column}>
                      {item[column] === null || item[column] === undefined
                        ? "—"
                        : typeof item[column] === "boolean"
                          ? item[column]
                            ? "Yes"
                            : "No"
                          : String(item[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.items?.length === 0 && (
        <p className="result-empty">No items were returned for this request.</p>
      )}
    </section>
  );
}

export function Pipeline({
  providers,
  onConnections,
  onSchedule,
  onSettings,
  request,
  onAuthError,
  origin,
}: CommonProps & {
  origin: string;
  onConnections: () => void;
  onSchedule: () => void;
  onSettings: () => void;
}) {
  const [providerId, setProviderId] = useState("");
  const [actionId, setActionId] = useState("");
  const prefix = useId();
  const platformProviders = providers.filter((item) => item.category !== "ai");
  const provider =
    platformProviders.find((item) => item.id === providerId) ||
    platformProviders.find((item) => item.actions?.length) ||
    platformProviders[0];
  const actions = provider?.actions || [];
  const action = actions.find((item) => item.id === actionId) || actions[0];
  const xai = providers.find((item) => item.id === "xai");

  return (
    <div className="workbench-page pipeline-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">YOUR BOT. YOUR ACCOUNTS.</div>
          <h1>
            Connect your AI apps<span>.</span>
          </h1>
          <p>
            Use your existing AI subscriptions to work with your connected
            platforms through Connector.
          </p>
        </div>
        <button className="button button-secondary" onClick={onSchedule}>
          Scheduled jobs →
        </button>
      </section>
      <AiConnections request={request} onSettings={onSettings} onAuthError={onAuthError} />
      <p className="setup-help">
        To choose different Google accounts and apps for each AI, first create
        an agent profile in Google Workspace. Select that profile when you
        approve the AI connection.
      </p>
      <section className="action-panel pipeline-capabilities">
        <div className="action-panel-heading">
          <h2>Available capabilities</h2>
          <p>
            The bot discovers these supported actions and their required fields
            from Connector.
          </p>
        </div>
        <div className="field-grid action-selectors">
          <div className="field">
            <label className="field-label" htmlFor={`${prefix}-provider`}>
              Platform
            </label>
            <select
              id={`${prefix}-provider`}
              value={provider?.id || ""}
              onChange={(event) => {
                setProviderId(event.target.value);
                setActionId("");
              }}
            >
              {platformProviders.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.connection?.status !== "connected"
                    ? " · Not connected"
                    : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${prefix}-action`}>
              Available action
            </label>
            <select
              id={`${prefix}-action`}
              value={action?.id || ""}
              disabled={!actions.length}
              onChange={(event) => setActionId(event.target.value)}
            >
              {!actions.length && (
                <option value="">No platform operations</option>
              )}
              {actions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {action && provider ? (
          <>
            <div className="action-summary">
              <span className={`action-summary-badge ${action.kind}-kind`}>
                {action.kind === "write" ? "Changes your account" : "Read only"}
              </span>
              {action.schedulable && (
                <span className="action-summary-badge read-kind">
                  Scheduling available
                </span>
              )}
              <p>{action.description}</p>
              <code>
                {provider.id} / {action.id}
              </code>
            </div>
            <div className="capability-fields">
              {action.fields.length ? (
                <dl>
                  {action.fields.map((field) => (
                    <div key={field.name}>
                      <dt>
                        {field.label} <code>{field.name}</code>
                      </dt>
                      <dd>
                        {field.required ? "Required" : "Optional"} ·{" "}
                        {field.type}
                        {field.help && <p>{field.help}</p>}
                        {field.options && (
                          <p>
                            Options:{" "}
                            {field.options
                              .map(
                                (option) => `${option.label} (${option.value})`,
                              )
                              .join(", ")}
                          </p>
                        )}
                        {field.default !== undefined && (
                          <p>Default: {field.default || "(empty)"}</p>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>This action does not require additional fields.</p>
              )}
            </div>
            {provider.connection?.status !== "connected" && (
              <p className="capability-connect">
                Connect and verify this platform before asking the bot to use
                it.{" "}
                <button className="text-button" onClick={onConnections}>
                  Manage connections →
                </button>
              </p>
            )}
            <div className="capability-note">
              <p>
                Platform permissions, account type, app approval, and API access
                levels determine which operations an account can use.
              </p>
              <a
                className="text-link"
                href={provider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Official documentation ↗
              </a>
            </div>
          </>
        ) : (
          <div className="capability-note">
            <p>
              {provider?.category === "ai"
                ? "AI connections provide optional developer API access. An xAI API key is used by the optional local bot; the direct Grok MCP connection does not require it."
                : "No operations are currently available through this connector."}
            </p>
          </div>
        )}
      </section>
      <details className="setup-advanced developer-options">
        <summary>Advanced: developer API and local bot</summary>
        <section className="action-panel pipeline-endpoints">
          <div className="action-panel-heading">
            <h2>Pipeline endpoints and tools</h2>
            <p>
              Use the same pipeline from a client that supports MCP or HTTP
              tools.
            </p>
          </div>
          <div className="endpoint-grid">
            <div>
              <h3>MCP endpoint</h3>
              <code>{origin}/mcp</code>
              <p>Use a client that supports Streamable HTTP MCP.</p>
            </div>
            <div>
              <h3>REST API</h3>
              <code>{origin}/api/v1</code>
              <p>Use HTTP requests from your own automation.</p>
            </div>
          </div>
          <div className="pipeline-auth">
            <h3>Authentication</h3>
            <p>
              Configure your client’s secure credential settings to send{" "}
              <code>Authorization: Bearer &lt;PIPELINE_API_KEY&gt;</code>. The
              key can be copied from the advanced Connector API key option above. Keep it
              private and never paste it into a chat.
            </p>
            <p>
              A remote bot needs a publicly reachable HTTPS endpoint. The URLs
              above use your configured workspace address. Use Settings to start
              public access if this is a local or HTTP address.
            </p>
          </div>
          <div className="pipeline-tools">
            <h3>Available tools</h3>
            <ul>
              {[
                "list_connections",
                "list_actions",
                "run_action",
                "schedule_post",
                "list_jobs",
                "cancel_job",
              ].map((tool) => (
                <li key={tool}>
                  <code>{tool}</code>
                </li>
              ))}
            </ul>
            <p>
              Writes require <code>confirmed: true</code>. Clients should ask
              for your approval before publishing, replying, sending
              conversions, changing campaigns, or scheduling a write.
            </p>
          </div>
        </section>
        <section className="action-panel pipeline-start">
          <div className="action-panel-heading">
            <h2>Optional: run a local Grok API bot</h2>
            <p>
              Use this alternative when you want a terminal-based bot instead of
              the custom connector in your existing Grok interface.
            </p>
          </div>
          <ol className="guide-steps">
            <li>
              <span>1</span>
              <div>
                <h3>Connect an xAI developer API key</h3>
                <p>
                  This optional bot uses separately billed xAI API access. Your
                  xAI API connection is{" "}
                  {xai?.connection?.status === "connected"
                    ? "connected and verified"
                    : "not connected yet"}
                  .
                </p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h3>Start the local bot</h3>
                <p>
                  Keep Connector running. In a second terminal in the project
                  directory, run:
                </p>
                <code className="pipeline-command">npm run grok</code>
                <p>
                  It uses the pipeline key from the server environment and asks
                  for your approval before actions that change an account.
                </p>
              </div>
            </li>
          </ol>
        </section>
      </details>
    </div>
  );
}

export function Schedule({
  providers,
  request,
  onAuthError,
  onPipeline,
}: CommonProps & { onPipeline: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [cancel, setCancel] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const requestRef = useRef(request);
  const authRef = useRef(onAuthError);
  requestRef.current = request;
  authRef.current = onAuthError;
  const fetchBusy = useRef(false);
  const cancelling = useRef(false);

  const load = async () => {
    if (fetchBusy.current) return;
    fetchBusy.current = true;
    setRefreshing(true);
    try {
      const response = await requestRef.current<{ jobs: Job[] }>("/api/jobs");
      setJobs(response.jobs);
      setError("");
    } catch (cause) {
      setError(message(cause));
      authRef.current(cause);
    } finally {
      fetchBusy.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  };
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);

  const cancelJob = async () => {
    if (!cancel || cancelling.current) return;
    cancelling.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`/api/jobs/${encodeURIComponent(cancel.id)}`, {
        method: "DELETE",
      });
      setCancel(null);
      setNotice("The pending job was cancelled.");
      await load();
    } catch (cause) {
      setCancel(null);
      setError(message(cause));
      onAuthError(cause);
    } finally {
      cancelling.current = false;
      setBusy(false);
    }
  };
  const describe = (job: Job) => {
    const provider = providers.find((item) => item.id === job.provider);
    return {
      provider: provider?.name || job.provider,
      action:
        provider?.actions?.find((item) => item.id === job.action)?.label ||
        job.action,
    };
  };
  const statusLabels: Record<Job["status"], string> = {
    pending: "Scheduled",
    running: "Running",
    succeeded: "Completed",
    failed: "Failed",
    uncertain: "Check platform",
    cancelled: "Cancelled",
  };

  return (
    <div className="schedule-page">
      <section className="page-heading schedule-heading">
        <div>
          <div className="eyebrow">PLAN AHEAD</div>
          <h1>
            Your schedule<span>.</span>
          </h1>
          <p>Keep track of publications scheduled through Connector.</p>
        </div>
        <button className="button button-primary" onClick={onPipeline}>
          Open pipeline →
        </button>
      </section>
      <div className="section-heading">
        <div>
          <h2>
            Scheduled jobs <span>{jobs.length}</span>
          </h2>
          <p className="schedule-refresh-note">
            Times are shown in{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}. Updates every 15
            seconds.
          </p>
        </div>
        <button
          className="text-button"
          disabled={refreshing}
          onClick={() => void load()}
        >
          {refreshing ? <Busy /> : "↻"} Refresh
        </button>
      </div>
      {error && (
        <div className="feedback feedback-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="feedback feedback-success" role="status">
          <span>{notice}</span>
        </div>
      )}
      {loading ? (
        <div className="empty-state" role="status">
          <Busy />
          <p>Loading your schedule…</p>
        </div>
      ) : !jobs.length ? (
        <div className="empty-state">
          <span className="eyebrow">ROOM FOR WHAT’S NEXT</span>
          <h2>No scheduled publications yet</h2>
          <p>
            Ask your bot to schedule a supported publication through the
            connector. Its status will appear here.
          </p>
          <button className="button button-secondary" onClick={onPipeline}>
            Open pipeline
          </button>
        </div>
      ) : (
        <div className="job-list">
          {jobs.map((job) => {
            const label = describe(job);
            return (
              <article className="job-card" key={job.id}>
                <div className="job-main">
                  <div className="job-title">
                    <span className={`job-status status-${job.status}`}>
                      {statusLabels[job.status]}
                    </span>
                    <h3>{label.action}</h3>
                  </div>
                  <p className="job-meta">
                    <strong>{label.provider}</strong>
                    <span>Scheduled for {dateLabel(job.scheduledAt)}</span>
                    {job.finishedAt && (
                      <span>Finished {dateLabel(job.finishedAt)}</span>
                    )}
                  </p>
                  {job.error && <p className="job-error">{job.error}</p>}
                  {job.status === "uncertain" && (
                    <p className="job-error">
                      The platform may have received this action. Check the
                      platform before submitting it again.
                    </p>
                  )}
                </div>
                <div className="job-actions">
                  {job.result && (
                    <button
                      className="button button-secondary"
                      aria-expanded={expanded === job.id}
                      onClick={() =>
                        setExpanded(expanded === job.id ? null : job.id)
                      }
                    >
                      {expanded === job.id ? "Hide result" : "View result"}
                    </button>
                  )}
                  {job.status === "pending" && (
                    <button
                      className="button button-danger-subtle"
                      disabled={busy}
                      onClick={() => setCancel(job)}
                    >
                      Cancel job
                    </button>
                  )}
                </div>
                {expanded === job.id && job.result && (
                  <div className="job-details">
                    <Results result={job.result} />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      <div className="info-note">
        <p>
          Keep Connector running to process scheduled jobs. Actions are not
          automatically retried, which helps avoid duplicate publications.
          Cancel is available while a job is pending.
        </p>
      </div>
      {cancel && (
        <ReviewDialog
          title="Cancel scheduled job?"
          confirmLabel="Cancel scheduled job"
          busy={busy}
          onClose={() => setCancel(null)}
          onConfirm={() => void cancelJob()}
        >
          <div className="action-review">
            <dl>
              <div className="action-review-row">
                <dt>Platform</dt>
                <dd>{describe(cancel).provider}</dd>
              </div>
              <div className="action-review-row">
                <dt>Action</dt>
                <dd>{describe(cancel).action}</dd>
              </div>
              <div className="action-review-row">
                <dt>Scheduled for</dt>
                <dd>{dateLabel(cancel.scheduledAt)}</dd>
              </div>
            </dl>
            <p className="review-warning">
              Connector will remove this pending job from the schedule. A job
              that has already started cannot be cancelled here.
            </p>
          </div>
        </ReviewDialog>
      )}
    </div>
  );
}
