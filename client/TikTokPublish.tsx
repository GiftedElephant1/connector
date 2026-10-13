import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ActionResult, ActionValues } from "../server/action-types";
import "./pipeline.css";
import "./tiktok-publish.css";

type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type Creator = {
  name: string;
  username: string;
  privacy: string[];
  maxSeconds: number;
  commentsDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
};
const privacyLabels: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends (mutual followers)",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};
const musicUrl = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
const brandedUrl = "https://www.tiktok.com/legal/page/global/bc-policy/en";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed. Please try again.";
}
function parseCreator(result: ActionResult): Creator {
  const item = result.items?.[0];
  if (!item || typeof item.privacyOptions !== "string" || typeof item.maxVideoSeconds !== "number" || item.maxVideoSeconds <= 0) {
    throw new Error("TikTok did not return valid publishing options. Refresh them before publishing.");
  }
  return {
    name: String(item.creator || "TikTok creator"), username: String(item.username || ""),
    privacy: item.privacyOptions.split(",").map((option) => option.trim()).filter((option) => option in privacyLabels),
    maxSeconds: item.maxVideoSeconds, commentsDisabled: item.commentsDisabled === true,
    duetDisabled: item.duetDisabled === true, stitchDisabled: item.stitchDisabled === true,
  };
}
function Result({ result, title }: { result: ActionResult | null; title: string }) {
  if (!result) return null;
  return <section className="tiktok-result" aria-label={title}>
    <h3>{title}</h3><p>{result.summary}</p>
    {result.items?.length === 0 && <p>No matching public video was returned. Check that this video belongs to the connected account and is available to the Display API.</p>}
    {result.items?.map((item, index) => <dl key={index}>{Object.entries(item).map(([key, value]) =>
      <div key={key}><dt>{key}</dt><dd>{value === null || value === "" ? "—" : String(value)}</dd></div>)}</dl>)}
  </section>;
}

export function TikTokPublish({ request, onAuthError, connected, onConnect }: {
  request: Request;
  onAuthError: (error: unknown) => void;
  connected: boolean;
  onConnect?: () => void;
}) {
  const prefix = useId();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [title, setTitle] = useState("");
  const [privacy, setPrivacy] = useState("");
  const [allowComments, setAllowComments] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [brandOrganic, setBrandOrganic] = useState(false);
  const [brandContent, setBrandContent] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [consent, setConsent] = useState(false);
  const [review, setReview] = useState<ActionValues | null>(null);
  const [submission, setSubmission] = useState<ActionResult | null>(null);
  const [publishId, setPublishId] = useState("");
  const [status, setStatus] = useState<ActionResult | null>(null);
  const [videoId, setVideoId] = useState("");
  const [metrics, setMetrics] = useState<ActionResult | null>(null);
  const attempt = useRef<{ payload: string; id: string } | null>(null);
  const reviewing = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const loaded = useRef(false);

  async function run(action: string, values: ActionValues = {}, requestId?: string) {
    return request<{ result: ActionResult }>(`/api/actions/tiktok/${action}`, {
      method: "POST", body: JSON.stringify({ values, ...(requestId ? { confirmed: true, requestId } : {}) }),
    });
  }
  function report(error: unknown) { setError(errorText(error)); onAuthError(error); }
  async function loadCreator() {
    setBusy("creator"); setError(""); setCreator(null); setPrivacy(""); setConsent(false); setReview(null);
    try {
      const response = await run("creator-info");
      if (mounted.current) {
        const next = parseCreator(response.result);
        setCreator(next); setAllowComments(false); setAllowDuet(false); setAllowStitch(false);
      }
    } catch (error) { if (mounted.current) report(error); }
    finally { if (mounted.current) setBusy(""); }
  }
  useEffect(() => {
    mounted.current = true;
    if (connected && !loaded.current) { loaded.current = true; void loadCreator(); }
    return () => { mounted.current = false; };
  }, [connected]);
  useEffect(() => { if (review) reviewing.current?.focus(); }, [review]);

  function preview() {
    setError(""); setPreviewError(""); setDuration(null); setPreviewUrl(""); setReview(null); setConsent(false);
    try {
      const url = new URL(videoUrl.trim());
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use a public HTTPS video URL without a username or password.");
      setVideoUrl(url.href); setPreviewUrl(url.href); setPreviewVersion((version) => version + 1);
    } catch (error) { setPreviewError(error instanceof TypeError ? "Enter a valid HTTPS video URL." : errorText(error)); }
  }
  const durationValid = duration !== null && duration > 0 && creator !== null && duration <= creator.maxSeconds;
  const previewReady = previewUrl === videoUrl && durationValid && !previewError;
  const canReview = connected && !!creator && previewReady && !!title.trim() && creator.privacy.includes(privacy) && consent && !(brandContent && privacy === "SELF_ONLY");

  function prepareReview(event: FormEvent) {
    event.preventDefault();
    if (!canReview || busy || submission) return;
    const yesNo = (value: boolean) => value ? "yes" : "no";
    setError("");
    setReview({ videoUrl, title, privacy, allowComments: yesNo(allowComments && !creator?.commentsDisabled), allowDuet: yesNo(allowDuet && !creator?.duetDisabled), allowStitch: yesNo(allowStitch && !creator?.stitchDisabled), brandOrganic: yesNo(brandOrganic), brandContent: yesNo(brandContent), aiGenerated: yesNo(aiGenerated), consent: "I agree" });
  }
  async function publish() {
    if (!review || busy || submission) return;
    const payload = JSON.stringify(review);
    if (attempt.current?.payload !== payload) attempt.current = { payload, id: crypto.randomUUID() };
    setBusy("publish"); setError("");
    try {
      const response = await run("publish", review, attempt.current.id);
      setSubmission(response.result); setPublishId(String(response.result.items?.[0]?.publishId || "")); setStatus(null); setReview(null);
    } catch (error) { report(error); }
    finally { setBusy(""); }
  }
  async function readResult(action: "publish-status" | "analytics", event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(action); setError("");
    try {
      const response = await run(action, action === "publish-status" ? { publishId } : { videoId });
      if (action === "publish-status") setStatus(response.result); else setMetrics(response.result);
    } catch (error) { report(error); }
    finally { setBusy(""); }
  }

  return <div className="tiktok-publish workbench-page">
    <section className="page-heading"><div><div className="eyebrow">TIKTOK</div><h1>TikTok publishing<span>.</span></h1><p>Preview and approve a video for your connected TikTok account, then check its publication status and available metrics.</p></div></section>
    {!connected ? <section className="action-panel tiktok-notice"><h2>Connect TikTok first</h2><p>Use Login Kit to authorize your TikTok account. For a first app review, connect an approved test account from your TikTok developer sandbox.</p>{onConnect && <button className="button button-primary" onClick={onConnect}>Connect TikTok</button>}</section> : <>
      <section className="action-panel tiktok-creator" aria-label="Connected TikTok creator"><div><h2>{creator ? creator.name : "Publishing account"}</h2>{creator?.username && <p>@{creator.username}</p>}<p>{creator ? `TikTok allows videos up to ${creator.maxSeconds} seconds for this account.` : busy === "creator" ? "Loading current publishing options from TikTok…" : "Refresh the account’s publishing options before preparing a video."}</p></div><button className="button button-secondary" disabled={!!busy || !!review} onClick={() => void loadCreator()}>Refresh publishing options</button></section>
      <p className="tiktok-sandbox-note">Before TikTok approves Direct Post, publishing is restricted by its sandbox and unaudited-app rules, including private visibility. The choices below come from TikTok for this account.</p>
      {error && <div className="tiktok-error" role="alert">{error}{busy !== "creator" && attempt.current && !submission && <p>If the connection failed during submission, check Scheduled jobs for the saved attempt before preparing another video. Retrying an unchanged request uses the same request ID.</p>}</div>}
      <section className="action-panel"><div className="action-panel-heading"><h2>Prepare a video</h2><p>The video must be hosted on an HTTPS domain or URL prefix verified in your TikTok developer app. Previewing loads it directly in this browser.</p></div>
        <form className="action-form" onSubmit={prepareReview}><fieldset className="tiktok-fields" disabled={!!busy || !!review || !!submission || !creator}>
          <div className="field"><label className="field-label" htmlFor={`${prefix}-url`}>Video HTTPS URL</label><input id={`${prefix}-url`} type="url" required value={videoUrl} placeholder="https://your-verified-domain.example/video.mp4" onChange={(event) => { setVideoUrl(event.target.value); setDuration(null); setPreviewUrl(""); setPreviewError(""); setConsent(false); }} /><div><button className="button button-secondary" type="button" onClick={preview} disabled={!videoUrl.trim()}>Preview video</button></div></div>
          {previewUrl && <div className="tiktok-preview"><video key={previewVersion} src={previewUrl} controls preload="metadata" aria-label="TikTok video preview" onLoadedMetadata={(event) => { const seconds = event.currentTarget.duration; if (!Number.isFinite(seconds) || seconds <= 0) { setPreviewError("The video duration could not be read. Use a video file with valid metadata."); return; } setDuration(seconds); }} onError={() => { setDuration(null); setPreviewError("This video could not be loaded. Check that its HTTPS URL serves a playable video without a login, then preview again."); }} /><p>{duration !== null ? `Video length: ${Math.ceil(duration)} seconds.` : "Waiting for video metadata…"}</p></div>}
          {previewError && <p className="field-error" role="alert">{previewError}</p>}
          {duration !== null && creator && duration > creator.maxSeconds && <p className="field-error" role="alert">This video exceeds TikTok’s {creator.maxSeconds}-second limit for this account. Choose a shorter video.</p>}
          <div className="field"><label className="field-label" htmlFor={`${prefix}-caption`}>Caption</label><textarea id={`${prefix}-caption`} required maxLength={2200} value={title} onChange={(event) => { setTitle(event.target.value); setConsent(false); }} /><p className="field-help">{title.length}/2,200 characters. You can edit the caption before publishing.</p></div>
          <div className="field"><label className="field-label" htmlFor={`${prefix}-privacy`}>Who can watch this video?</label><select id={`${prefix}-privacy`} required value={privacy} onChange={(event) => { setPrivacy(event.target.value); setConsent(false); }}><option value="">Choose privacy</option>{creator?.privacy.map((value) => <option key={value} value={value} disabled={brandContent && value === "SELF_ONLY"}>{privacyLabels[value]}{brandContent && value === "SELF_ONLY" ? " (unavailable for branded content)" : ""}</option>)}</select>{creator?.privacy.length === 0 && <p className="field-error">TikTok returned no supported privacy settings. Publishing is unavailable for this account.</p>}</div>
          <fieldset className="tiktok-choices"><legend>Allow viewers to</legend>{[
            { label: "Comment", value: allowComments, set: setAllowComments, disabled: creator?.commentsDisabled },
            { label: "Duet", value: allowDuet, set: setAllowDuet, disabled: creator?.duetDisabled },
            { label: "Stitch", value: allowStitch, set: setAllowStitch, disabled: creator?.stitchDisabled },
          ].map((item) => <label key={item.label}><input type="checkbox" checked={item.value && !item.disabled} disabled={item.disabled} onChange={(event) => item.set(event.target.checked)} /><span>{item.label}{item.disabled && <small>Disabled by this account’s TikTok settings</small>}</span></label>)}</fieldset>
          <fieldset className="tiktok-choices"><legend>Content disclosures</legend><label><input type="checkbox" checked={brandOrganic} onChange={(event) => { setBrandOrganic(event.target.checked); setConsent(false); }} /><span>Promotes your own brand<small>TikTok will label this as promotional content.</small></span></label><label><input type="checkbox" checked={brandContent} onChange={(event) => { setBrandContent(event.target.checked); setConsent(false); if (event.target.checked && privacy === "SELF_ONLY") setPrivacy(""); }} /><span>Paid partnership / branded content<small>TikTok will label this as a paid partnership. Branded content cannot use Only me privacy.</small></span></label><label><input type="checkbox" checked={aiGenerated} onChange={(event) => { setAiGenerated(event.target.checked); setConsent(false); }} /><span>AI-generated content<small>Apply TikTok’s AI-generated content label when required for this video.</small></span></label></fieldset>
          <label className="tiktok-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>I have the rights to publish this video and agree to TikTok’s <a href={musicUrl} target="_blank" rel="noopener noreferrer">Music Usage Confirmation</a>{(brandOrganic || brandContent) && <> and <a href={brandedUrl} target="_blank" rel="noopener noreferrer">Branded Content Policy</a></>}.</span></label>
          <div className="action-controls"><span className="field-help">Load the video preview, choose privacy, and accept the terms to continue.</span><button className="button button-primary" type="submit" disabled={!canReview}>Review video</button></div>
        </fieldset></form>
      </section>
      {review && <section className="action-panel tiktok-review" aria-label="Review TikTok video"><h2 ref={reviewing} tabIndex={-1}>Review before publishing</h2><p>This submits the video to {creator?.name}{creator?.username ? ` (@${creator.username})` : ""} on TikTok.</p><dl><div><dt>Caption</dt><dd>{review.title}</dd></div><div><dt>Privacy</dt><dd>{privacyLabels[review.privacy]}</dd></div><div><dt>Interactions</dt><dd>Comments: {review.allowComments}; Duet: {review.allowDuet}; Stitch: {review.allowStitch}</dd></div><div><dt>Disclosures</dt><dd>Own brand: {review.brandOrganic}; Paid partnership: {review.brandContent}; AI-generated: {review.aiGenerated}</dd></div></dl><p>By publishing, you approve this exact video, caption, settings, and content declarations. TikTok may take several minutes to process a submission.</p><div className="action-controls"><button className="button button-secondary" disabled={!!busy} onClick={() => setReview(null)}>Back to editing</button><button className="button button-primary" disabled={!!busy} onClick={() => void publish()}>{busy === "publish" ? "Submitting…" : "Publish to TikTok"}</button></div></section>}
      <Result title="Video submission" result={submission} />
      {submission && <div className="tiktok-next"><p>Submission acceptance is not confirmation that your video is published. Check its status below and view it in TikTok.</p><button className="button button-secondary" disabled={!!busy} onClick={() => { setSubmission(null); setVideoUrl(""); setPreviewUrl(""); setDuration(null); setPreviewError(""); setTitle(""); setPrivacy(""); setConsent(false); setBrandOrganic(false); setBrandContent(false); setAiGenerated(false); setAllowComments(false); setAllowDuet(false); setAllowStitch(false); attempt.current = null; }}>Prepare another video</button></div>}
      <div className="tiktok-read-grid"><section className="action-panel"><div className="action-panel-heading"><h2>Publication status</h2><p>Use the publish ID returned when TikTok accepted a submission.</p></div><form className="action-form" onSubmit={(event) => void readResult("publish-status", event)}><div className="field"><label className="field-label" htmlFor={`${prefix}-publish-id`}>Publish ID</label><input id={`${prefix}-publish-id`} disabled={!!busy} required maxLength={300} value={publishId} onChange={(event) => { setPublishId(event.target.value); setStatus(null); }} /></div><div className="action-controls"><button className="button button-secondary" disabled={!!busy || !publishId.trim()}>Check publication status</button></div></form><Result title="Publication result" result={status} /></section>
      <section className="action-panel"><div className="action-panel-heading"><h2>Video metrics</h2><p>Enter a public video ID owned by this TikTok account. Private sandbox posts may be unavailable to the Display API.</p></div><form className="action-form" onSubmit={(event) => void readResult("analytics", event)}><div className="field"><label className="field-label" htmlFor={`${prefix}-video-id`}>Owned public video ID</label><input id={`${prefix}-video-id`} disabled={!!busy} required inputMode="numeric" pattern="[0-9]{1,30}" maxLength={30} value={videoId} onChange={(event) => { setVideoId(event.target.value); setMetrics(null); }} /><p className="field-help">The digits after /video/ in the video’s TikTok URL.</p></div><div className="action-controls"><button className="button button-secondary" disabled={!!busy || !/^\d{1,30}$/.test(videoId)}>Read video metrics</button></div></form><Result title="Video metrics result" result={metrics} /></section></div>
    </>}
  </div>;
}
