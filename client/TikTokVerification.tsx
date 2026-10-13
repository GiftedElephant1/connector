import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CopyValue, type ApiRequest } from "./Setup";

type Verification = { filename: string | null; publicUrl: string | null };

export function TikTokVerification({ request, origin }: { request: ApiRequest; origin?: string | null }) {
  const id = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<Verification | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    request<Verification>("/api/tiktok/verification").then((result) => {
      if (active) setSaved(result);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load the verification file settings.");
    });
    return () => { active = false; };
  }, [request, origin, attempt]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!/^tiktok[A-Za-z0-9_-]{0,100}\.txt$/.test(file.name)) throw new Error("Choose the original TikTok verification file named tiktok….txt. Do not rename it.");
      if (file.size === 0 || file.size > 16_384) throw new Error("Use a nonempty TikTok verification text file no larger than 16 KB.");
      let content: string;
      try {
        // Keep whitespace and a possible UTF-8 BOM: TikTok must receive the original file content.
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error("This file is not valid UTF-8 text. Download the original verification file from TikTok again.");
      }
      setSaved(await request<Verification>("/api/tiktok/verification", {
        method: "PUT", body: JSON.stringify({ filename: file.name, content }),
      }));
      setFile(null);
      if (picker.current) picker.current.value = "";
      setNotice("Verification file published. Open the preview, then return to TikTok and run its verification check.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not publish the verification file.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setSaved(await request<Verification>("/api/tiktok/verification", { method: "DELETE" }));
      setNotice("Verification file removed from this installation.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the verification file.");
    } finally {
      setBusy(false);
    }
  }

  return <details className="setup-advanced review-verification">
    <summary>TikTok asks me to upload a verification file</summary>
    <p className="setup-help">If TikTok offers file-based verification for your Connector website domain, download its original tiktok….txt file. Choose that file below and click Publish verification file. Connector will serve it at the root of this installation’s address. This does not verify a video hosted on a different domain.</p>
    <form className="setup-form" onSubmit={upload}>
      <label htmlFor={id}>TikTok website verification file</label>
      <input ref={picker} id={id} type="file" accept=".txt,text/plain" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] || null); setError(""); setNotice(""); }} />
      <p className="setup-help">Keep the filename and contents TikTok supplied. Uploading another file replaces the previous verification file. Only TikTok verification TXT files up to 16 KB are accepted.</p>
      <button type="submit" className="button button-secondary" disabled={busy || !file}>{busy ? "Updating verification file…" : "Publish verification file"}</button>
    </form>
    {saved?.filename && <div>
      <p className="setup-help">Published file: <strong>{saved.filename}</strong></p>
      {saved.publicUrl?.startsWith("https://") && <CopyValue label="TikTok verification file URL" value={saved.publicUrl} />}
      <div className="setup-button-row">
        {saved.publicUrl && <a className="button button-secondary" href={saved.publicUrl} target="_blank" rel="noopener noreferrer">Preview verification file ↗</a>}
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => void remove()}>Remove verification file</button>
      </div>
    </div>}
    {!origin?.startsWith("https://") && <p className="setup-help">Start public access before asking TikTok to check this file. A file served only at localhost is not reachable by TikTok.</p>}
    <p className="setup-help">Once the public preview matches the downloaded file, return to the Developer Portal and click its verification control. Keep the file available for future checks. If TikTok requires DNS verification instead, follow that option with your domain provider; this upload cannot create a DNS record.</p>
    {notice && <p className="setup-notice" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!saved && error && <button type="button" className="button button-secondary" onClick={() => setAttempt((value) => value + 1)}>Retry verification settings</button>}
  </details>;
}
