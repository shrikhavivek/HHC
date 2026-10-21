"use client";
import { Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { rememberStory, storyDestination } from "@/lib/editorial-flow";
import { useStoryDraft } from "@/lib/use-story-draft";

export type StoryWorkspaceHandle = { flush: () => Promise<boolean> };
export type StorySelection = { id: string; celebrity: string; designer: string; title: string; latest_collage?: { id: string; preview_url: string } | null; collage_editor: { revision?: number } };
const labels = { title: "Add a headline.", body: "Write the story before reviewing your draft.", alt_text: "Describe the collage for readers using screen readers.", credits: "Add the photo credits." };
type Field = keyof typeof labels;

export function StoryWorkspace({ selected, username, initialReview = false, onEditCollage, ref }: { selected: StorySelection; username: string; initialReview?: boolean; onEditCollage: () => void; ref?: Ref<StoryWorkspaceHandle> }) {
  const draft = useStoryDraft(selected.id, username);
  const [review, setReview] = useState(initialReview);
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const feedback = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const { story } = draft;
  useImperativeHandle(ref, () => ({ flush: () => busy ? Promise.resolve(false) : !story ? Promise.resolve(true) : draft.flush() }));
  useEffect(() => {
    rememberStory(username, selected.id, review ? "review" : "story");
    const url = storyDestination(selected.id, review ? "review" : "story");
    window.history.replaceState(null, "", url);
    heading.current?.focus();
  }, [review, selected.id, username]);
  useEffect(() => {
    void fetch("/api/backend/wordpress/connection").then(async response => { if (response.ok) setEnabled(Boolean((await response.json()).enabled)); }).catch(() => {});
  }, []);
  useEffect(() => {
    // A new collage needs a fresh review; stale confirmation must not block autosave.
    if (story?.reviewed_collage_id && story.reviewed_collage_id !== selected.latest_collage?.id) draft.change({ reviewed_collage_id: null });
  }, [story?.reviewed_collage_id, selected.latest_collage?.id]);
  useEffect(() => { if (message || draft.error) feedback.current?.scrollIntoView({ block: "nearest" }); }, [message, draft.error]);
  const missing = (field: Field) => !story?.[field].trim();
  const fieldError = (field: Field) => (attempted || touched[field]) && missing(field) ? labels[field] : "";
  const loginUrl = `/?next=${encodeURIComponent(storyDestination(selected.id, review ? "review" : "story"))}`;
  async function reviewDraft() {
    setAttempted(true); setMessage("");
    const first = (Object.keys(labels) as Field[]).find(missing);
    if (first) { requestAnimationFrame(() => document.getElementById(`story-${first}`)?.focus()); return; }
    if (!selected.latest_collage) { setMessage("Create and save a collage before reviewing this draft."); return; }
    setBusy(true);
    if (await draft.flush()) setReview(true);
    setBusy(false);
  }
  async function send(reconcile = false) {
    if (busy || !story) return;
    setAttempted(true); setMessage("");
    if (!reconcile) {
      const first = (Object.keys(labels) as Field[]).find(missing);
      if (first || !selected.latest_collage) { setReview(false); setMessage("Complete the story and collage before continuing."); return; }
      if (story.reviewed_collage_id !== selected.latest_collage.id) { setMessage("Confirm the photo rights and credits below the preview."); document.getElementById("story-rights")?.focus(); return; }
    }
    setBusy(true);
    try {
      if (!reconcile && !await draft.flush()) return;
      setMessage("Opening WordPress sign-in…");
      const response = await fetch("/api/wordpress/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_id: selected.id, reconcile }), signal: AbortSignal.timeout(45000) });
      const result = await response.json();
      if (response.status === 401) setNeedsLogin(true);
      if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "WordPress could not be reached. Please try again.");
      if (!result.redirect_url) throw new Error("WordPress did not return a sign-in link. Please try again.");
      window.location.assign(result.redirect_url);
    } catch (error) { setMessage(error instanceof Error ? error.message : "WordPress could not be reached. Please try again."); }
    finally { setBusy(false); }
  }
  if (draft.loading) return <p className="edition-message" role="status">Opening your story…</p>;
  return <div className="story-workspace">
    <ol className="editorial-steps" aria-label="Draft progress">{["Choose photos", "Edit collage", "Write story", "Review", "WordPress draft"].map((label, index) => <li key={label} aria-current={index === (review ? 3 : 2) ? "step" : undefined}>{label}</li>)}</ol>
    <div className="story-workspace-heading"><h3 tabIndex={-1} ref={heading}>{review ? "Review your draft" : "Write your story"}</h3><span role="status" aria-label="Save status">{draft.error ? "Not saved" : draft.saving ? "Saving…" : draft.dirty ? "Waiting to save…" : story?.revision ? "Saved" : "Not saved yet"}</span></div>
    {draft.recovered && <p className="edition-hint">Your unfinished edits have been restored.</p>}
    {(draft.error || message) && <p ref={feedback} className="edition-message" role="alert">{draft.error || message}</p>}
    {(draft.expired || needsLogin) && <a className="edition-wordpress-link" href={loginUrl}>Sign in again to continue this story</a>}
    {draft.conflict ? <div className="story-actions"><button type="button" onClick={() => void draft.resolveConflict(false)}>Load saved version</button><button type="button" onClick={() => void draft.resolveConflict(true)}>Keep my edits</button></div> : draft.error && !draft.expired && story && <button type="button" onClick={() => void draft.flush()}>Retry saving</button>}
    {!story && !draft.expired && <button type="button" onClick={() => window.location.reload()}>Try again</button>}
    {story && !review && <form className="edition-form story-edit-form" onSubmit={event => { event.preventDefault(); void reviewDraft(); }} noValidate>
      <fieldset disabled={busy}>
        <label htmlFor="story-title">Headline</label><input id="story-title" value={story.title} maxLength={300} aria-invalid={Boolean(fieldError("title"))} aria-describedby="story-title-error" onBlur={() => setTouched(value => ({ ...value, title: true }))} onChange={event => draft.change({ title: event.target.value })}/><p className="story-field-error" id="story-title-error">{fieldError("title")}</p>
        {(["body", "alt_text", "credits"] as const).map(field => <div key={field}><label htmlFor={`story-${field}`}>{({ body: "The story", alt_text: "Image description", credits: "Photo credits" })[field]}</label><textarea id={`story-${field}`} className={field === "body" ? "edition-body" : ""} value={story[field]} maxLength={field === "body" ? 20000 : field === "alt_text" ? 1000 : 3000} aria-invalid={Boolean(fieldError(field))} aria-describedby={`story-${field}-error`} onBlur={() => setTouched(value => ({ ...value, [field]: true }))} onChange={event => draft.change({ [field]: event.target.value })}/><p className="story-field-error" id={`story-${field}-error`}>{fieldError(field)}</p></div>)}
        <footer><button type="button" onClick={onEditCollage}>Edit collage</button><button type="submit" className="edition-primary">Review draft</button></footer>
      </fieldset>
      <p className="edition-hint">Your story saves automatically as you write.</p>
    </form>}
    {story && review && <section className="story-review" aria-label="Final draft preview">
      <h2>{story.title || "Headline needed"}</h2>
      {selected.latest_collage ? <figure><img src={`/media${selected.latest_collage.preview_url}`} alt={story.alt_text}/><figcaption>{story.credits}</figcaption></figure> : <p className="story-field-error">Create and save a collage first.</p>}
      <div className="story-review-body">{story.body.split(/\n\n/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      <p className="edition-hint"><strong>Image description:</strong> {story.alt_text || "Add an image description."}</p>
      <label className="edition-check"><input id="story-rights" type="checkbox" disabled={busy || !selected.latest_collage} checked={Boolean(selected.latest_collage && story.reviewed_collage_id === selected.latest_collage.id)} onChange={event => { setMessage(""); draft.change({ reviewed_collage_id: event.target.checked ? selected.latest_collage?.id || null : null }); }}/><span>I have checked the photos, usage rights, credits and outfit attribution.</span></label>
      {attempted && story.reviewed_collage_id !== selected.latest_collage?.id && <p className="story-field-error">Confirm the photos and credits before continuing.</p>}
      <div className="story-actions"><button type="button" disabled={busy} onClick={() => { setReview(false); setMessage(""); setAttempted(false); }}>Edit story</button><button type="button" disabled={busy} onClick={onEditCollage}>Edit collage</button><button type="button" className="edition-primary" disabled={busy || !enabled || draft.conflict} onClick={() => void send()}>{busy ? "Opening WordPress…" : "Continue to WordPress ↗"}</button></div>
      <p className="edition-hint">Sign in to create your draft. You’ll review and publish it in WordPress.</p>
      {!enabled && <p className="story-field-error">WordPress draft sending is not enabled for this installation.</p>}
    </section>}
    {story && ["uncertain", "sending"].includes(story.sync_state) && <div className="story-recovery"><p>An earlier send needs checking before you send again.</p><button type="button" disabled={busy} onClick={() => void send(true)}>Check previous handoff</button></div>}
  </div>;
}
