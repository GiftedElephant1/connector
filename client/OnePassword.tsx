import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type {
  OnePasswordAccount,
  OnePasswordCheck,
  OnePasswordField,
  OnePasswordItem,
  OnePasswordLinkInput,
  OnePasswordLinkView,
  OnePasswordSnapshot,
  OnePasswordUseResult,
  OnePasswordVault,
} from "../server/onepassword-types";
import type { ApiRequest } from "./Setup";
import "./onepassword.css";

const endpoint = "/api/onepassword";
const emptyLink = (): OnePasswordLinkInput => ({
  name: "", accountId: "", vaultId: "", itemId: "", targetId: "", fields: {}, literals: {}, principals: [],
});
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The 1Password request could not be completed. Try again.";

export function OnePassword({ request, onApplied, onAuthError }: {
  request: ApiRequest;
  onApplied?: () => void;
  onAuthError?: (error: unknown) => void;
}) {
  const id = useId();
  const [data, setData] = useState<OnePasswordSnapshot | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [executable, setExecutable] = useState("");
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [check, setCheck] = useState<OnePasswordCheck | null>(null);
  const [accounts, setAccounts] = useState<OnePasswordAccount[]>([]);
  const [vaults, setVaults] = useState<OnePasswordVault[]>([]);
  const [items, setItems] = useState<OnePasswordItem[]>([]);
  const [fields, setFields] = useState<OnePasswordField[]>([]);
  const [link, setLink] = useState<OnePasswordLinkInput>(emptyLink);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editor = useRef<HTMLFormElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const target = data?.targets.find(item => item.id === link.targetId);
  const dirty = !!data && (data.enabled !== enabled || data.executable !== executable.trim());
  const canRead = !!data?.enabled && !dirty && !busy;
  const formReady = !!target && !!link.accountId && !!link.vaultId && !!link.itemId && !!link.name.trim() &&
    Object.keys(link.fields).some(key => !!link.fields[key]) &&
    target.fields.every(field => !(field.secret && field.source === "literal") && (!field.required || !!(field.source === "vault" ? link.fields[field.key] : link.literals[field.key]?.trim())));

  function snapshot(next: OnePasswordSnapshot) {
    setData(next); setEnabled(next.enabled); setExecutable(next.executable);
  }
  function clearSelection() {
    setAccounts([]); setVaults([]); setItems([]); setFields([]); setLink(emptyLink()); setEditingId(null);
  }
  async function run(name: string, task: () => Promise<void>) {
    setBusy(name); setError(""); setNotice("");
    try { await task(); }
    catch (cause) { setError(errorMessage(cause)); onAuthError?.(cause); }
    finally { setBusy(""); }
  }
  async function load() {
    await run("loading", async () => { snapshot(await request<OnePasswordSnapshot>(endpoint)); });
  }
  useEffect(() => {
    let active = true;
    request<OnePasswordSnapshot>(endpoint).then(result => {
      if (active) { snapshot(result); setBusy(""); }
    }).catch(cause => {
      if (active) { setError(errorMessage(cause)); setBusy(""); onAuthError?.(cause); }
    });
    return () => { active = false; };
  }, [request]);
  useEffect(() => {
    if (error) { feedback.current?.focus(); feedback.current?.scrollIntoView({ block: "nearest" }); }
  }, [error]);

  async function saveConfiguration(event: FormEvent) {
    event.preventDefault();
    await run("save", async () => {
      const next = await request<OnePasswordSnapshot>(endpoint, { method: "PUT", body: JSON.stringify({ enabled, executable: executable.trim() }) });
      snapshot(next); clearSelection(); setCheck(null);
      setNotice(next.enabled ? "1Password setup saved. Check the CLI, then load your accounts." : "New 1Password reads are disabled. Previously connected accounts remain connected.");
    });
  }
  async function loadAccounts() {
    clearSelection();
    await run("accounts", async () => {
      const result = await request<{ accounts: OnePasswordAccount[] }>(`${endpoint}/accounts`, { method: "POST", body: "{}" });
      setAccounts(result.accounts);
      if (!result.accounts.length) setNotice("No 1Password accounts were found. Sign in to the desktop app and enable its CLI integration, then load accounts again.");
    });
  }
  async function chooseAccount(accountId: string) {
    setLink(previous => ({ ...emptyLink(), targetId: previous.targetId, accountId }));
    setVaults([]); setItems([]); setFields([]);
    if (!accountId) return;
    await run("vaults", async () => {
      const result = await request<{ vaults: OnePasswordVault[] }>(`${endpoint}/vaults`, { method: "POST", body: JSON.stringify({ accountId }) });
      setVaults(result.vaults);
      if (!result.vaults.length) setNotice("No vaults are available for this account.");
    });
  }
  async function chooseVault(vaultId: string) {
    setLink(previous => ({ ...previous, vaultId, itemId: "", fields: {}, literals: {}, principals: [] }));
    setItems([]); setFields([]);
    if (!vaultId) return;
    await run("items", async () => {
      const result = await request<{ items: OnePasswordItem[] }>(`${endpoint}/items`, { method: "POST", body: JSON.stringify({ accountId: link.accountId, vaultId }) });
      setItems(result.items);
      if (!result.items.length) setNotice("No items are available in this vault.");
    });
  }
  async function chooseItem(itemId: string) {
    setLink(previous => ({ ...previous, itemId, fields: {}, literals: {}, principals: [], name: items.find(item => item.id === itemId)?.title || "" }));
    setFields([]);
    if (!itemId) return;
    await run("fields", async () => {
      const result = await request<{ fields: OnePasswordField[] }>(`${endpoint}/fields`, { method: "POST", body: JSON.stringify({ accountId: link.accountId, vaultId: link.vaultId, itemId }) });
      setFields(result.fields);
      if (!result.fields.length) setNotice("This item has no supported credential fields. Choose another item.");
    });
  }
  async function saveLink(event: FormEvent) {
    event.preventDefault();
    if (!formReady) return;
    await run("link", async () => {
      const body: OnePasswordLinkInput = {
        ...link, name: link.name.trim(),
        fields: Object.fromEntries(Object.entries(link.fields).filter(([, value]) => !!value)),
        literals: Object.fromEntries(Object.entries(link.literals).filter(([, value]) => !!value.trim()).map(([key, value]) => [key, value.trim()])),
        principals: target?.agentUsable ? link.principals : [],
      };
      snapshot(await request<OnePasswordSnapshot>(`${endpoint}/links${editingId ? `/${encodeURIComponent(editingId)}` : ""}`, { method: editingId ? "PUT" : "POST", body: JSON.stringify(body) }));
      setLink(previous => ({ ...emptyLink(), accountId: previous.accountId, vaultId: previous.vaultId })); setFields([]);
      setEditingId(null);
      setNotice("Credential link saved. Choose Use now below to retrieve it and update the selected connection.");
    });
  }
  async function editLink(item: OnePasswordLinkView) {
    await run("edit", async () => {
      const nextAccounts = await request<{ accounts: OnePasswordAccount[] }>(`${endpoint}/accounts`, { method: "POST", body: "{}" });
      const nextVaults = await request<{ vaults: OnePasswordVault[] }>(`${endpoint}/vaults`, { method: "POST", body: JSON.stringify({ accountId: item.accountId }) });
      const nextItems = await request<{ items: OnePasswordItem[] }>(`${endpoint}/items`, { method: "POST", body: JSON.stringify({ accountId: item.accountId, vaultId: item.vaultId }) });
      const nextFields = await request<{ fields: OnePasswordField[] }>(`${endpoint}/fields`, { method: "POST", body: JSON.stringify({ accountId: item.accountId, vaultId: item.vaultId, itemId: item.itemId }) });
      setAccounts(nextAccounts.accounts); setVaults(nextVaults.vaults); setItems(nextItems.items); setFields(nextFields.fields);
      const { id: _id, targetLabel: _label, lastUsedAt: _used, ...input } = item;
      setLink({ ...input, fields: { ...input.fields }, literals: { ...input.literals }, principals: [...input.principals] });
      setEditingId(item.id);
      setNotice("Editing the saved credential link. Save changes to update its destination and AI access.");
      window.requestAnimationFrame(() => { editor.current?.scrollIntoView({ block: "start" }); editor.current?.querySelector<HTMLInputElement>(`[data-link-name]`)?.focus(); });
    });
  }
  async function useLink(linkId: string) {
    await run(`use:${linkId}`, async () => {
      const result = await request<OnePasswordUseResult>(`${endpoint}/links/${encodeURIComponent(linkId)}/use`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
      setNotice(result.message); onApplied?.();
      // Keep the successful import visible even if refreshing its metadata fails.
      try { snapshot(await request<OnePasswordSnapshot>(endpoint)); } catch { /* The use response already confirms the saved connection. */ }
    });
  }
  return (
    <section className="setup-panel onepassword-panel" id="onepassword" aria-labelledby={`${id}-title`}>
      <div className="setup-panel-heading">
        <div><div className="eyebrow">SAVED CREDENTIALS</div><h2 id={`${id}-title`}>1Password</h2></div>
        {data && <span className={`setup-status ${data.enabled ? "ready" : ""}`}>{data.enabled ? "Enabled" : "Off"}</span>}
      </div>
      <p className="setup-description">Choose a saved login or API credential once, then let Connector retrieve it from 1Password. Passwords and API keys stay on the Connector server and are never returned to AI agents.</p>
      <div ref={feedback} tabIndex={-1} className={error ? "onepassword-feedback error" : "onepassword-feedback"} role={error ? "alert" : "status"}>
        {error || notice || (busy === "loading" ? "Loading 1Password setup…" : "")}
      </div>
      {!data && !busy && <button className="button button-secondary" onClick={() => void load()}>Retry 1Password setup</button>}
      {data && <>
        <details className="onepassword-help" open={!data.enabled || check?.installed === false}>
          <summary>Set up 1Password on this PC</summary>
          <ol>
            <li>Install the <a href="https://1password.com/downloads" target="_blank" rel="noopener noreferrer">1Password desktop app</a> and <a href="https://developer.1password.com/docs/cli/get-started/" target="_blank" rel="noopener noreferrer">1Password CLI</a> on the computer running Connector.</li>
            <li>Sign in to 1Password and unlock it. Open <strong>Settings → Developer → Integrate with 1Password CLI</strong>. {data.windows && <>Enable Windows Hello in 1Password’s security settings.</>}</li>
            <li>Save the setup below, click <strong>Check 1Password CLI</strong>, then <strong>Load 1Password accounts</strong>. Approve any access request in the 1Password desktop app.</li>
          </ol>
          {data.windows && <p className="setup-help">For guided Windows installation, run <strong>Setup 1Password.vbs</strong> from your Connector installation folder.</p>}
          <a className="text-link" href="onepassword://settings/developers">Open 1Password developer settings ↗</a>
          <p className="setup-help">If you just installed the CLI, restart Connector so it can find it. Unlock or approve 1Password when requested; your master password is never entered here. The 1Password MCP server manages Developer Environments; these saved-item connections use the CLI.</p>
        </details>
        <form className="setup-form onepassword-config" onSubmit={saveConfiguration} aria-label="1Password configuration">
          <label className="onepassword-checkbox"><input type="checkbox" checked={enabled} disabled={!!busy} onChange={event => setEnabled(event.currentTarget.checked)} />Enable 1Password credential retrieval</label>
          <label htmlFor={`${id}-executable`}>1Password CLI path (optional)</label>
          <input id={`${id}-executable`} value={executable} onChange={event => setExecutable(event.target.value)} disabled={!!busy} placeholder={data.windows ? "Leave blank to find op.exe automatically" : "Leave blank to find op automatically"} autoComplete="off" spellCheck={false} />
          <p className="setup-help">Use a full executable path only if Connector cannot find the installed CLI.</p>
          <div className="setup-button-row">
            <button className="button button-primary" type="submit" disabled={!!busy}>{busy === "save" ? "Saving…" : "Save 1Password setup"}</button>
            <button className="button button-secondary" type="button" disabled={!!busy || dirty} onClick={() => void run("check", async () => { setCheck(await request<OnePasswordCheck>(`${endpoint}/check`, { method: "POST", body: "{}" })); })}>{busy === "check" ? "Checking…" : "Check 1Password CLI"}</button>
          </div>
          {dirty && <p className="setup-help">Save your changes before loading 1Password.</p>}
          {check && <p className="onepassword-check" role="status">{check.message}{check.version && <> Version {check.version}.</>}</p>}
        </form>
        <div className="onepassword-section-heading"><h3>Link a credential</h3><button className="button button-secondary" disabled={!canRead} onClick={() => void loadAccounts()}>{busy === "accounts" ? "Waiting for 1Password…" : "Load 1Password accounts"}</button></div>
        <p className="setup-help">Only account, vault, item, and field names appear here. Select fields by name; their secret values are read on the server. Account names, usernames, client IDs, and URLs may appear in ordinary connection settings.</p>
        {accounts.length > 0 && <form ref={editor} className="setup-form onepassword-link-form" aria-label="Link a 1Password credential" onSubmit={saveLink}>
          <fieldset disabled={!canRead}>
            <label htmlFor={`${id}-account`}>1Password account</label>
            <select id={`${id}-account`} value={link.accountId} onChange={event => void chooseAccount(event.target.value)} required><option value="">Choose an account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
            <label htmlFor={`${id}-vault`}>1Password vault</label>
            <select id={`${id}-vault`} value={link.vaultId} onChange={event => void chooseVault(event.target.value)} required disabled={!canRead || !vaults.length}><option value="">Choose a vault</option>{vaults.map(vault => <option key={vault.id} value={vault.id}>{vault.name}</option>)}</select>
            <label htmlFor={`${id}-item`}>1Password item</label>
            <select id={`${id}-item`} value={link.itemId} onChange={event => void chooseItem(event.target.value)} required disabled={!canRead || !items.length}><option value="">Choose an item</option>{items.map(item => <option key={item.id} value={item.id}>{item.title} · {item.category}</option>)}</select>
            <label htmlFor={`${id}-target`}>Connector destination</label>
            <select id={`${id}-target`} value={link.targetId} onChange={event => setLink(previous => ({ ...previous, targetId: event.target.value, fields: {}, literals: {}, principals: [] }))} required><option value="">Choose a destination</option>{data.targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
            {target && <p className="setup-help">{target.description}</p>}
            {target && fields.length > 0 && <>
              <label htmlFor={`${id}-name`}>Credential link name</label>
              <input data-link-name id={`${id}-name`} value={link.name} onChange={event => setLink(previous => ({ ...previous, name: event.target.value }))} maxLength={100} required />
              <div className="onepassword-field-mapping">
                <h4>Choose the saved fields</h4>
                {target.fields.map(field => <div key={field.key}>
                  <label htmlFor={`${id}-field-${field.key}`}>{field.label}{field.required ? "" : " (optional)"}</label>
                  {field.source === "vault" ? <select id={`${id}-field-${field.key}`} value={link.fields[field.key] || ""} required={field.required} onChange={event => { const value = event.target.value; setLink(previous => ({ ...previous, fields: { ...previous.fields, [field.key]: value } })); }}>
                    <option value="">{field.required ? "Choose a 1Password field" : "Leave unchanged"}</option>
                    {fields.map(item => <option key={item.id} value={item.id}>{item.label}{item.purpose ? ` · ${item.purpose.toLowerCase()}` : ""}</option>)}
                  </select> : !field.secret ? <input id={`${id}-field-${field.key}`} value={link.literals[field.key] || ""} required={field.required} maxLength={2048} onChange={event => { const value = event.target.value; setLink(previous => ({ ...previous, literals: { ...previous.literals, [field.key]: value } })); }} /> : <p role="alert">This credential requires a saved 1Password field.</p>}
                  {!field.secret && <p className="setup-help">This is visible connection information. Choose a matching non-secret value.</p>}
                </div>)}
              </div>
              <fieldset className="onepassword-agent-access">
                <legend>AI connections allowed to use this credential</legend>
                <p className="setup-help">Access starts off. Selected AI connections can retrieve this credential into its fixed Connector destination; they cannot read its password or key. The resulting connected account is available according to Connector’s existing platform permissions.</p>
                {target.agentUsable ? data.principals.length ? data.principals.map(principal => <label key={principal.id} className="onepassword-checkbox"><input type="checkbox" checked={link.principals.includes(principal.id)} onChange={event => { const checked = event.currentTarget.checked; setLink(previous => ({ ...previous, principals: checked ? [...previous.principals, principal.id] : previous.principals.filter(value => value !== principal.id) })); }} />{principal.label}</label>) : <p className="setup-help">No eligible AI connections are available. You can still use this credential from the dashboard.</p> : <p className="setup-help">Only you can apply credentials to this destination from the dashboard.</p>}
              </fieldset>
              <div className="setup-button-row">
                <button className="button button-primary" type="submit" disabled={!canRead || !formReady}>{busy === "link" ? "Saving link…" : editingId ? "Save link changes" : "Save credential link"}</button>
                {editingId && <button className="button button-secondary" type="button" onClick={() => { setEditingId(null); setLink(emptyLink()); setVaults([]); setItems([]); setFields([]); }}>Cancel link editing</button>}
              </div>
            </>}
          </fieldset>
        </form>}
        <div className="onepassword-section-heading"><h3>Saved credential links</h3></div>
        <p className="setup-help">Use now reads the current value from 1Password and stores it in Connector’s encrypted credential storage. Future platform calls use that saved copy. Google authorization, MFA, and subscription sign-ins still use their official sign-in screens.</p>
        {!data.links.length && <p className="setup-help">No 1Password credentials linked yet.</p>}
        <div className="onepassword-links">{data.links.map(item => <article className="onepassword-link" key={item.id} aria-label={`${item.name} credential link`}>
          <h4>{item.name}</h4><p>{item.targetLabel}</p>
          <p className="setup-help">{item.principals.length ? `AI access: ${item.principals.map(value => data.principals.find(principal => principal.id === value)?.label || "Unavailable connection").join(", ")}` : "AI access: off. Only you can use this link."}</p>
          {item.lastUsedAt && <p className="setup-help">Last used: {new Date(item.lastUsedAt).toLocaleString()}</p>}
          <div className="setup-button-row">
            <button className="button button-primary" disabled={!canRead} onClick={() => void useLink(item.id)}>{busy === `use:${item.id}` ? "Waiting for 1Password…" : "Use now"}</button>
            <button className="button button-secondary" disabled={!canRead} onClick={() => void editLink(item)}>Edit link</button>
            <button className="button button-secondary" disabled={!!busy} onClick={() => void run(`remove:${item.id}`, async () => { snapshot(await request<OnePasswordSnapshot>(`${endpoint}/links/${encodeURIComponent(item.id)}`, { method: "DELETE" })); setNotice("Credential link removed. Previously imported accounts remain connected; disconnect them separately if needed."); })}>Remove link</button>
          </div>
        </article>)}</div>
      </>}
    </section>
  );
}
