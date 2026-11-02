import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AiTask, OutboundProvider, OutboundProviderView } from "../server/outbound-types";
import type { ApiRequest } from "./Setup";
import "./outbound-ai.css";

type OutboundData = { allowSharedKey: boolean; providers: OutboundProviderView[]; tasks: AiTask[] };
type Model = { id: string; name: string; subscriptionEligible: boolean };
const names: Record<OutboundProvider, string> = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", cursor: "Cursor", grok: "Grok Bot" };
const localSetup = {
  claude: { executable: "claude", tool: "Claude Code", command: "claude", followup: "In Claude Code, enter /login and sign in with your eligible Claude subscription.", docs: "https://code.claude.com/docs/en/setup" },
  chatgpt: { executable: "codex", tool: "Codex", command: "codex login", followup: "Choose Sign in with ChatGPT and finish the browser sign-in using your existing account.", docs: "https://developers.openai.com/codex/cli" },
  gemini: { executable: "agy", tool: "Antigravity", command: "agy", followup: "Complete Antigravity’s interactive sign-in with your personal Google AI Pro account. Keep AI Credit Overages off.", docs: "https://antigravity.google/docs/install?tab=cli" },
};
const message = (cause: unknown) => cause instanceof Error ? cause.message : "The request could not be completed.";
function taskLink(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

function ProviderSetup({ provider, request, onSaved, onChecked, onAuthError }: {
  provider: OutboundProviderView; request: ApiRequest; onSaved: () => Promise<void>;
  onChecked: (provider: OutboundProviderView) => void; onAuthError?: (error: unknown) => void;
}) {
  const id = useId();
  const [enabled, setEnabled] = useState(provider.enabled);
  const [executable, setExecutable] = useState(provider.executable || "");
  const [model, setModel] = useState(provider.model || "");
  const [apiKey, setApiKey] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookKey, setWebhookKey] = useState("");
  const [models, setModels] = useState<Model[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = names[provider.id];
  const local = provider.id === "claude" || provider.id === "chatgpt" || provider.id === "gemini" ? localSetup[provider.id] : null;
  const dirty = enabled !== provider.enabled || executable !== (provider.executable || "") || model !== (provider.model || "") || Boolean(apiKey || webhookUrl || webhookKey);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await request(`/api/outbound-ai/providers/${provider.id}`, { method: "PUT", body: JSON.stringify({ enabled,
        ...(local ? { executable: executable.trim() } : {}),
        ...(provider.id === "cursor" ? { ...(model ? { model } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } : {}),
        ...(provider.id === "grok" ? { ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}), ...(webhookKey.trim() ? { webhookKey: webhookKey.trim() } : {}) } : {}),
      }) });
      setApiKey(""); setWebhookUrl(""); setWebhookKey("");
      await onSaved();
    } catch (cause) { setError(message(cause)); onAuthError?.(cause); }
    finally { setBusy(false); }
  }
  async function check() {
    setBusy(true); setError("");
    try { const result = await request<{ provider: OutboundProviderView }>(`/api/outbound-ai/providers/${provider.id}/check`, { method: "POST", body: "{}" }); onChecked(result.provider); }
    catch (cause) { setError(message(cause)); onAuthError?.(cause); }
    finally { setBusy(false); }
  }
  async function loadModels() {
    setBusy(true); setError("");
    try {
      const result = await request<{ models: Model[] }>("/api/outbound-ai/providers/cursor/models", { method: "POST", body: JSON.stringify(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      const eligible = result.models.filter((item) => item.subscriptionEligible);
      setModels(eligible);
      if (!eligible.some((item) => item.id === model)) setModel("");
    } catch (cause) { setError(message(cause)); onAuthError?.(cause); }
    finally { setBusy(false); }
  }
  return <form className="outbound-provider-setup" aria-label={`${name} outbound setup`} onSubmit={save}>
    <h3>Send tasks to {name}</h3>
    {local && <>
      <p>Install the official {local.tool} tool on the PC running Connector. Open a terminal as the same Windows user who starts Connector, then run <code>{local.command}</code>. {local.followup}</p>
      <p>Connector uses that local sign-in for a new text task. It does not retrieve your existing chat history or automatically share your connected account credentials.</p>
      <a className="text-link" href={local.docs} target="_blank" rel="noopener noreferrer">Official {local.tool} setup guide ↗</a>
      <label htmlFor={`${id}-executable`}>Executable path (optional)</label>
      <input id={`${id}-executable`} value={executable} onChange={event => setExecutable(event.target.value)} placeholder={`Use ${local.executable} from this PC’s PATH`} disabled={busy} autoComplete="off" />
      <p className="setup-help">If the readiness check cannot find it, enter the full path to the installed executable. Save the setup, then check readiness. Readiness checks do not send a task or use model credits.</p>
    </>}
    {provider.id === "cursor" && <>
      <p>Use the official Cursor Cloud Agent API with a model included in your Cursor subscription. Create a Cursor API key in your Cursor account settings, then load the models available to that key. This is a Cursor account credential, not an OpenAI or Anthropic model key.</p>
      <p><a className="text-link" href="https://cursor.com/dashboard/api" target="_blank" rel="noopener noreferrer">Open Cursor API keys ↗</a></p>
      <a className="text-link" href="https://cursor.com/docs/cloud-agent/api/endpoints" target="_blank" rel="noopener noreferrer">Official Cursor Cloud Agent setup guide ↗</a>
      <label htmlFor={`${id}-api-key`}>Cursor API key</label>
      <input id={`${id}-api-key`} type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setModels(null); setModel(""); }} placeholder={provider.hasApiKey ? "Already saved — leave blank to keep" : "Paste your Cursor API key"} autoComplete="new-password" disabled={busy} />
      <button className="button button-secondary" type="button" onClick={() => void loadModels()} disabled={busy || (!apiKey.trim() && !provider.hasApiKey)}>Load subscription models</button>
      <label htmlFor={`${id}-model`}>Cursor subscription model</label>
      <select id={`${id}-model`} value={model} onChange={event => setModel(event.target.value)} disabled={busy}>
        <option value="">Choose a subscription model</option>
        {models === null && provider.model && !apiKey && <option value={provider.model}>{provider.model} (saved model)</option>}
        {models?.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select>
      <p className="setup-help">Only models marked as included in your subscription are offered. Third-party models that require separate billing are excluded. Your Cursor plan’s remaining allowance and billing settings still apply.</p>
      {models?.length === 0 && <p className="setup-help" role="status">No subscription-eligible models were returned. Check your Cursor account and plan before enabling task sending.</p>}
    </>}
    {provider.id === "grok" && <>
      <p>Create a routine in your Grok Bot with a webhook trigger, then paste its private webhook URL here. Connector sends your task to that routine; read the result in the Bot’s conversation. Configure the routine to use the received prompt and avoid delegating back to itself or retriggering the same routine. A delivered webhook is not a completed AI task.</p>
      <a className="text-link" href="https://docs.x.ai/grok-bot/skills-routines-and-automations#webhooks" target="_blank" rel="noopener noreferrer">Official Grok Bot routine guide ↗</a>
      <label htmlFor={`${id}-webhook-url`}>Grok routine webhook URL</label>
      <input id={`${id}-webhook-url`} type="password" value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} placeholder={provider.hasWebhookUrl ? "Already saved — leave blank to keep" : "Paste the private webhook URL"} autoComplete="new-password" disabled={busy} required={enabled && !provider.hasWebhookUrl} />
      <label htmlFor={`${id}-webhook-key`}>Grok routine webhook key</label>
      <input id={`${id}-webhook-key`} type="password" value={webhookKey} onChange={event => setWebhookKey(event.target.value)} placeholder={provider.hasWebhookKey ? "Already saved — leave blank to keep" : "Paste the routine’s webhook key"} autoComplete="new-password" disabled={busy} required={enabled && !provider.hasWebhookKey} />
      <p className="setup-help">The URL and key stay hidden after saving. The readiness check validates the saved setup without triggering the routine.</p>
    </>}
    <label className="outbound-checkbox"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} /><span>Enable {name} task sending</span></label>
    <p className="setup-help">Disabling task sending preserves the saved setup and blocks new tasks. Tasks already sent may still finish.</p>
    <div className="outbound-buttons"><button className="button button-primary" type="submit" disabled={busy || (enabled && provider.id === "cursor" && !model)}>Save outbound setup</button><button className="button button-secondary" type="button" onClick={() => void check()} disabled={busy || dirty}>Check readiness</button></div>
    {dirty && <p className="setup-help">Save your changes before checking readiness.</p>}
    {provider.check && <p className={`outbound-readiness readiness-${provider.check.status}`} role="status"><strong>{provider.check.status === "ready" ? "Setup ready" : provider.check.status === "action_required" ? "Sign-in or setup needed" : "Unavailable"}:</strong> {provider.check.message}<small>Checked {new Date(provider.check.checkedAt).toLocaleString()}</small></p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </form>;
}

export function OutboundAi({ request, onAuthError }: { request: ApiRequest; onAuthError?: (error: unknown) => void }) {
  const [data, setData] = useState<OutboundData | null>(null);
  const [selected, setSelected] = useState<OutboundProvider>("claude");
  const [formVersion, setFormVersion] = useState(0);
  const [sharedAccess, setSharedAccess] = useState(false);
  const [accessDirty, setAccessDirty] = useState(false);
  const [pendingCancel, setPendingCancel] = useState<AiTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;
  const accessDirtyRef = useRef(accessDirty);
  accessDirtyRef.current = accessDirty;
  const load = useCallback(async () => {
    try {
      const result = await request<OutboundData>("/api/outbound-ai");
      setData(result);
      if (!accessDirtyRef.current) setSharedAccess(result.allowSharedKey);
      setError("");
    } catch (cause) { setError(message(cause)); authRef.current?.(cause); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);
  const activeIds = data?.tasks.filter(task => task.status === "running").map(task => task.id).join("\n") || "";
  useEffect(() => {
    if (!activeIds) return;
    let current = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const updates = await Promise.allSettled(activeIds.split("\n").map(taskId => request<{ task: AiTask }>(`/api/outbound-ai/tasks/${encodeURIComponent(taskId)}`)));
      if (current) {
        const received = new Map<string, AiTask>();
        for (const update of updates) {
          if (update.status === "fulfilled") received.set(update.value.task.id, update.value.task);
          else { setError(`Could not refresh an AI task: ${message(update.reason)}`); authRef.current?.(update.reason); }
        }
        if (received.size) setData(previous => previous ? { ...previous, tasks: previous.tasks.map(task => received.get(task.id) || task) } : previous);
      }
      polling = false;
    };
    const interval = window.setInterval(() => void poll(), 3000);
    return () => { current = false; window.clearInterval(interval); };
  }, [activeIds, request]);
  const provider = data?.providers.find(item => item.id === selected);
  const addTask = (task: AiTask) => setData(previous => previous ? { ...previous, tasks: [task, ...previous.tasks.filter(item => item.id !== task.id)].slice(0, 100) } : previous);
  async function saveAccess(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await request("/api/outbound-ai/access", { method: "POST", body: JSON.stringify({ allowSharedKey: sharedAccess }) });
      accessDirtyRef.current = false; setAccessDirty(false);
      setNotice(sharedAccess ? "Shared-key AI task access enabled. Clients holding that key can use the enabled agents." : "Shared-key AI task access disabled. Saved agent settings and other connections are preserved.");
      await load();
    } catch (cause) { setError(message(cause)); authRef.current?.(cause); }
    finally { setBusy(false); }
  }
  async function refreshTask(task: AiTask) {
    setBusy(true); setError("");
    try {
      const result = await request<{ task: AiTask }>(`/api/outbound-ai/tasks/${encodeURIComponent(task.id)}`);
      setData(previous => previous ? { ...previous, tasks: previous.tasks.map(item => item.id === result.task.id ? result.task : item) } : previous);
    } catch (cause) { setError(message(cause)); authRef.current?.(cause); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!pendingCancel) return;
    setBusy(true); setError("");
    try {
      const result = await request<{ task: AiTask }>(`/api/outbound-ai/tasks/${encodeURIComponent(pendingCancel.id)}/cancel`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
      addTask(result.task); setPendingCancel(null); setNotice("Cancellation requested. Review the task status; work already completed is not undone.");
    } catch (cause) { setError(message(cause)); authRef.current?.(cause); }
    finally { setBusy(false); }
  }
  return <section className="setup-panel outbound-ai" aria-label="Send tasks to AI agents">
    <div className="eyebrow">CONNECTOR → YOUR AI AGENTS</div>
    <h2>Send tasks to AI agents</h2>
    <p className="setup-description">Ask Grok Bot or another connected AI to delegate work to an AI destination here. Your AI writes the instructions, sends the task through Connector, checks progress, and brings the result back to your conversation.</p>
    <ol className="outbound-delegation-steps" aria-label="Set up AI-to-AI delegation">
      <li><strong>Enable the destination.</strong> Choose the AI that should do the work, save its setup, and check readiness.</li>
      <li><strong>Authorize your connected AI.</strong> Allow the AI you normally chat with to send tasks using the access settings below.</li>
      <li><strong>Ask in your usual AI conversation.</strong> For example: “Ask Gemini to review this draft and return its feedback. Do not publish or change anything.”</li>
    </ol>
    <p className="setup-help">Give requests in your usual AI conversation. Your connected AI supplies each task; Connector manages access and shows progress and results. Local destinations run on this PC; subscription limits apply. These are new tasks, not access to existing chat history.</p>
    {!data && !error && <p role="status">Loading AI task settings…</p>}
    {data && <>
      <div className="outbound-provider-options" role="group" aria-label="Choose an outbound AI agent">
        {data.providers.map(item => <button key={item.id} className={`outbound-provider-option ${selected === item.id ? "selected" : ""}`} aria-pressed={selected === item.id} aria-label={`Configure ${names[item.id]}`} onClick={() => { setSelected(item.id); setNotice(""); }}><strong>{names[item.id]}</strong><span>{item.enabled ? item.configured ? "Enabled" : "Setup needed" : "Off"}</span></button>)}
      </div>
      {provider && <ProviderSetup key={`${provider.id}-${formVersion}`} provider={provider} request={request} onAuthError={onAuthError}
        onSaved={async () => { await load(); setFormVersion(value => value + 1); setNotice(`${names[provider.id]} task setup saved. Existing platform connections are preserved.`); }}
        onChecked={checked => setData(previous => previous ? { ...previous, providers: previous.providers.map(item => item.id === checked.id ? checked : item) } : previous)} />}
      <section className="outbound-agent-access" aria-label="Authorize the AI that delegates tasks">
        <h3>Authorize the AI that delegates tasks</h3>
        <p>For Grok Bot using your existing general Connector key, enable and save shared-key task access below. Keep the same saved key and connected accounts.</p>
        <p>For an OAuth connection, use <strong>Enable AI delegation</strong> on its existing approval under <strong>Approved AI connections</strong> below, then confirm the change. You can also select <strong>Send tasks to AI agents</strong> during initial sign-in. The shared-key switch does not change OAuth approvals, and Google Workspace profile keys do not gain outbound task access.</p>
        <form onSubmit={saveAccess}>
          <label className="outbound-checkbox"><input type="checkbox" checked={sharedAccess} onChange={event => { setSharedAccess(event.target.checked); setAccessDirty(true); }} disabled={busy} /><span>Allow the shared Connector key to send AI tasks</span></label>
          <p className="setup-help">Off by default. Enabling this lets every client with your general Connector key send instructions to the enabled agents and read tasks available to that credential. This includes Grok Bot using the shared key. It can consume your AI subscription usage; approve only the task access you intend.</p>
          <button className="button button-secondary" type="submit" disabled={busy || !accessDirty}>Save shared-key access</button>
        </form>
        <p className="setup-help">If your AI does not yet know how to delegate, review its setup instructions below. The Grok Bot setup message already includes the delegation tools. Ask it to update its Connector instructions using its existing saved credential.</p>
        <button className="text-button" onClick={() => document.querySelector<HTMLElement>(".ai-connections")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Review incoming AI connection setup ↓</button>
        <details className="outbound-tool-help"><summary>How your AI delegates a task</summary><p>Your AI checks enabled destinations with <code>list_ai_agents</code>, sends your approved instructions using <code>start_ai_task</code>, and checks <code>get_ai_task</code> until it can return the result. It reuses the same request ID if a send needs retrying. These calls use the access you authorize above.</p></details>
      </section>
      <section className="outbound-task-history" aria-label="AI task history">
        <div className="outbound-history-heading"><h3>AI task history</h3><button className="text-button" onClick={() => void load()} disabled={busy}>Refresh AI tasks</button></div>
        {!data.tasks.length && <p className="setup-help">No tasks have been sent. Ask your connected AI to delegate work; its tasks will appear here.</p>}
        {data.tasks.map(task => { const link = taskLink(task.link); return <article className="outbound-task" key={task.id} data-task-id={task.id}>
          <div className="outbound-history-heading"><h4>{names[task.provider]}</h4><span className={`outbound-task-status task-${task.status}`}>{({ running: "Running", succeeded: "Succeeded", failed: "Failed", uncertain: "Result uncertain", cancelled: "Cancelled", submitted: "Submitted" })[task.status]}</span></div>
          <p className="setup-help">Created {new Date(task.createdAt).toLocaleString()} · Task <code>{task.id}</code></p>
          <details><summary>Task instructions and result</summary><h5>Task instructions</h5><pre>{task.prompt}</pre>{task.result && <><h5>Result</h5><pre>{task.result}</pre></>}</details>
          {task.error && <p className="inline-error">{task.error}</p>}
          {task.status === "submitted" && <p className="setup-help">The destination accepted the request. This does not confirm completion; read the result in the AI app.</p>}
          {task.status === "uncertain" && <p className="setup-help">Check the destination before sending another request. The task may have run even though its result could not be confirmed.</p>}
          <div className="outbound-buttons">{task.provider === "cursor" && ["running", "uncertain"].includes(task.status) && <button className="button button-secondary" onClick={() => void refreshTask(task)} disabled={busy}>Refresh task status</button>}{link && <a className="text-link" href={link} target="_blank" rel="noopener noreferrer">Open task in AI app ↗</a>}{task.provider !== "grok" && (task.status === "running" || (task.provider === "cursor" && task.status === "uncertain")) && <button className="button button-secondary" onClick={() => setPendingCancel(task)} disabled={busy}>Cancel task</button>}</div>
        </article>; })}
        {pendingCancel && <div className="outbound-cancel" role="group" aria-label="Confirm AI task cancellation"><p>Cancel the task sent to {names[pendingCancel.provider]}? This attempts to stop ongoing work; it does not undo anything already completed.</p><button className="button button-secondary" onClick={() => setPendingCancel(null)} disabled={busy}>Keep task running</button><button className="button button-danger" onClick={() => void cancel()} disabled={busy}>Confirm cancel task</button></div>}
      </section>
    </>}
    {notice && <p className="setup-notice" role="status">{notice}</p>}
    {error && <div className="inline-error" role="alert"><p>{error}</p>{!data && <button className="text-button" onClick={() => void load()}>Retry AI task settings</button>}</div>}
  </section>;
}
