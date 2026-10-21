"use client";
import { FormEvent, Ref, useEffect, useImperativeHandle, useRef, useState } from "react";

type Story = { title: string; body: string; alt_text: string; credits: string; category_ids: number[]; tag_ids: number[]; revision: number; reviewed_collage_id: string | null; wordpress_post_id?: number; sync_state: string };
type Selected = { id: string; celebrity: string; designer: string; title: string; latest_collage?: { id: string; preview_url: string } | null; collage_editor: { revision?: number } };
type Run = { id: string; status: string; created_at: string };
type Operations = { automatic: boolean; daily_time_utc: string; timezone: string; worker_online: boolean; reddit: { configured: boolean }; instagram: { configured: boolean; accounts: string[] }; wordpress: { enabled: boolean; site: string }; runs: Run[]; cooldowns: { provider: string; retry_at: number }[] };
type History = { versions: { id: string; created_at: string; preview_url: string }[]; events: { id: number; action: string; actor: string; created_at: string }[] };
type Taxonomy = { categories: { id: number; name: string }[]; tags: { id: number; name: string }[] };

export async function editorialRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api/backend/" + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Please check the form and try again.");
  return result;
}
function photo(path: string) { return "/media" + path; }
function readable(value: string) { return value.replaceAll("_", " "); }

export type EditorialDeskHandle = { sendDraft: () => void };

export function EditorialDesk({ selected, onRefresh, ref }: { selected: Selected | null; onRefresh: () => void; ref?: Ref<EditorialDeskHandle> }) {
  const [tab, setTab] = useState<"story" | "history" | "connections" | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [operations, setOperations] = useState<Operations | null>(null);
  const [taxonomy, setTaxonomy] = useState<Taxonomy>({ categories: [], tags: [] });
  const [connection, setConnection] = useState<{ connected: boolean; enabled: boolean; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const [editUrl, setEditUrl] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const saved = useRef("");
  const requestVersion = useRef(0);
  const refreshAction = useRef(onRefresh);
  refreshAction.current = onRefresh;
  const lastRuns = useRef("");
  function close() {
    if (busy) return;
    if (dirty && !window.confirm("Discard the unsaved story changes?")) return;
    dialog.current?.close(); setTab(null); setDirty(false);
  }
  async function open(next: typeof tab, sendAfterLoad = false) {
    if (busy) return;
    const version = ++requestVersion.current;
    setTab(next); setMessage(""); setDirty(false); setEditUrl("");
    setStory(null); setHistory(null); setConnection(null); setTaxonomy({ categories: [], tags: [] });
    dialog.current?.showModal(); setBusy(true);
    try {
      if (next === "story" && selected) {
        const data = await editorialRequest<Story>(`cases/${selected.id}/story`);
        if (version !== requestVersion.current) return;
        setStory(data); saved.current = JSON.stringify(data);
        const connected = await editorialRequest<{ connected: boolean; enabled: boolean; detail?: string }>("wordpress/connection");
        setConnection(connected);
        if (sendAfterLoad) {
          await startHandoff(selected.id);
          return;
        }
        if (connected.connected) setTaxonomy(await editorialRequest<Taxonomy>("wordpress/taxonomy"));
      } else if (next === "history" && selected) {
        setHistory(await editorialRequest<History>(`cases/${selected.id}/history`));
      } else if (next === "connections") {
        setOperations(await editorialRequest<Operations>("operations"));
      }
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  useImperativeHandle(ref, () => ({ sendDraft: () => { void open("story", true); } }));
  useEffect(() => {
    if (message) feedback.current?.scrollIntoView({ block: "nearest" });
  }, [message]);
  useEffect(() => {
    function update(data: Operations) {
      setOperations(data);
      const fingerprint = data.runs.map(run => run.id + ":" + run.status).join("|");
      if (!dialog.current?.open) {
        if (lastRuns.current && fingerprint !== lastRuns.current && data.runs.some(run => ["completed", "completed_with_warnings"].includes(run.status))) refreshAction.current();
        lastRuns.current = fingerprint;
      }
    }
    void editorialRequest<Operations>("operations").then(update).catch(() => {});
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void editorialRequest<Operations>("operations").then(update).catch(() => {});
    }, 30000);
    return () => clearInterval(poll);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  function change(patch: Partial<Story>) { if (story) { const next = { ...story, ...patch }; setStory(next); setDirty(JSON.stringify(next) !== saved.current); } }
  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!selected || !story) return;
    setBusy(true); setMessage("");
    try {
      const result = await editorialRequest<Story>(`cases/${selected.id}/story`, { ...story, expected_revision: story.revision });
      setStory(result); saved.current = JSON.stringify(result); setDirty(false); setMessage("Story saved.");
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  async function startHandoff(caseId: string, reconcile = false) {
    setMessage("Opening WordPress sign-in…");
    const response = await fetch("/api/wordpress/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_id: caseId, reconcile }), signal: AbortSignal.timeout(45000) });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "WordPress sign-in could not be opened.");
    if (!result.redirect_url) throw new Error("WordPress did not return a sign-in link. Please try again.");
    window.location.assign(result.redirect_url);
  }
  async function send(reconcile = false) {
    if (!selected || !story || busy) return;
    setBusy(true); setMessage("");
    try {
      if (reconcile && dirty) throw new Error("Save your changes before checking the previous handoff.");
      if (dirty) {
        const result = await editorialRequest<Story>(`cases/${selected.id}/story`, { ...story, expected_revision: story.revision });
        setStory(result); saved.current = JSON.stringify(result); setDirty(false);
      }
      await startHandoff(selected.id, reconcile);
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  async function refresh() {
    setBusy(true);
    try {
      await editorialRequest("runs/refresh", {});
      setOperations(await editorialRequest<Operations>("operations"));
      setMessage("Refresh queued. You can keep editing while the worker prepares the edition.");
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  async function restore(id: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await editorialRequest(`cases/${selected.id}/restore`, { collage_id: id, expected_revision: selected.collage_editor.revision || 0 });
      setMessage("Revision restored as a new draft."); onRefresh(); setHistory(await editorialRequest<History>(`cases/${selected.id}/history`));
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  const latest = operations?.runs[0];
  return <>
    <section className="edition-command" aria-label="Editorial tools">
      <div className="edition-command-title"><span className="edition-spark" aria-hidden>✦</span><div><small>Your editorial studio</small><strong>From a look to a story.</strong></div></div>
      <div className="edition-command-actions">
        <button type="button" onClick={() => void open("connections")}><span className={operations?.worker_online ? "live-dot" : "idle-dot"}/>{latest?.status === "running" ? "Refreshing edition" : "Sources & schedule"}</button>
        <button type="button" disabled={!selected?.latest_collage} onClick={() => void open("history")}>Version history</button>
        <button type="button" className="edition-primary" disabled={busy || !selected?.latest_collage} onClick={() => void open("story", true)} title={selected?.latest_collage ? "Continue to WordPress with this saved story" : "Select a look with a saved collage first"}>Send WordPress draft</button>
        <button type="button" className="edition-primary" disabled={!selected} onClick={() => void open("story")}>Write story <span aria-hidden>↗</span></button>
      </div>
    </section>
    <dialog className="edition-dialog" ref={dialog} onCancel={event => { event.preventDefault(); close(); }}>
      <header><div><small>High Heel Confidential / Editorial studio</small><h2>{tab === "story" ? "The story behind the look." : tab === "history" ? "Every edit, kept." : "A fresh edition. Every day."}</h2></div><button type="button" onClick={close} aria-label="Close editorial workspace">×</button></header>
      {message && !(tab === "story" && story) && <p ref={feedback} className="edition-message" role="status">{message}</p>}
      {busy && <div className="edition-progress" role="progressbar" aria-label="Working" />}
      {tab === "story" && story && selected && <div className="edition-compose">
        <aside className="edition-proof">
          {selected.latest_collage ? <img src={photo(selected.latest_collage.preview_url)} alt={story.alt_text || "Collage awaiting an image description"} /> : <div className="edition-no-image">Open the collage editor to prepare this story's image.</div>}
          <span className="edition-eyebrow">Editorial preview</span><h3>{story.title || selected.celebrity}</h3>
          <div className="edition-story-preview">{story.body || "Your words bring the look to life. Start writing beside the image."}</div>
          <small>{story.credits || "Photo credits pending"}</small>
        </aside>
        <form onSubmit={save} className="edition-form" inert={busy}>
          <div className="edition-save-state"><span>{dirty ? "Unsaved changes" : `Saved revision ${story.revision}`}</span><span>{connection?.connected ? "WordPress connected" : "Local draft"}</span></div>
          <label>Headline<input value={story.title} maxLength={300} required onChange={e => change({ title: e.target.value })} /></label>
          <label>The story<textarea className="edition-body" value={story.body} maxLength={20000} placeholder="Describe the look, identify the designer, and add your editorial take…" onChange={e => change({ body: e.target.value })} /></label>
          <label>Image description <small>For readers using screen readers</small><textarea value={story.alt_text} maxLength={1000} onChange={e => change({ alt_text: e.target.value })} /></label>
          <label>Photo credits<textarea value={story.credits} maxLength={3000} placeholder="Photographer / agency, credited for each selected panel" onChange={e => change({ credits: e.target.value })} /></label>
          {connection?.connected && <div className="edition-field-row">
            <label>Categories<select multiple value={story.category_ids.map(String)} onChange={e => change({ category_ids: [...e.target.selectedOptions].map(o => Number(o.value)) })}>{taxonomy.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label>Designer & celebrity tags<select multiple value={story.tag_ids.map(String)} onChange={e => change({ tag_ids: [...e.target.selectedOptions].map(o => Number(o.value)) })}>{taxonomy.tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          </div>}
          <label className="edition-check"><input type="checkbox" disabled={!selected.latest_collage} checked={Boolean(selected.latest_collage && story.reviewed_collage_id === selected.latest_collage.id)} onChange={e => change({ reviewed_collage_id: e.target.checked ? selected.latest_collage?.id || null : null })} /><span>I have checked the selected photos, their usage rights, credits and outfit attribution.</span></label>
          <footer><button type="submit" className="edition-primary" disabled={busy}>Save story</button><button type="button" disabled={busy} onClick={() => void send()}>Send WordPress draft ↗</button></footer>
          <p className="edition-hint">Saves your edits, then opens WordPress to sign in and create your draft.</p>
          {connection && !connection.enabled && <p className="edition-hint">WordPress draft sending needs to be enabled in this installation.</p>}
          {["uncertain", "sending"].includes(story.sync_state) && <button type="button" onClick={() => void send(true)} disabled={busy}>Check previous handoff</button>}
          {editUrl && <a className="edition-wordpress-link" href={editUrl} target="_blank" rel="noreferrer">Open draft in WordPress ↗</a>}
        </form>
        {message && <p ref={feedback} className="edition-message" role="status" style={{ gridColumn: "1 / -1" }}>{message}</p>}
      </div>}
      {tab === "history" && <div className="edition-history">
        <div className="edition-version-grid">{history?.versions.map((v, i) => <article key={v.id}><a href={photo(v.preview_url)} target="_blank" rel="noreferrer"><img src={photo(v.preview_url)} alt={`Collage revision saved ${new Date(v.created_at).toLocaleString()}`} /></a><div><strong>{i === 0 ? "Latest version" : `Version ${history.versions.length - i}`}</strong><small>{new Date(v.created_at).toLocaleString()}</small><button type="button" disabled={busy || i === 0} onClick={() => void restore(v.id)}>Restore as new draft</button></div></article>)}</div>
        {history?.versions.length === 0 && <p>No renders yet. Save a collage to start its history.</p>}
        <ol className="edition-timeline">{history?.events.map(e => <li key={e.id}><strong>{readable(e.action)}</strong><span>{e.actor} · {new Date(e.created_at).toLocaleString()}</span></li>)}</ol>
      </div>}
      {tab === "connections" && operations && <div className="edition-operations">
        <div className="edition-integration-grid">{[
          { name: "Reddit", glyph: "r/", connected: operations.reddit.configured, text: "Daily BollywoodFashion posts and archive research. Requires approved Reddit OAuth access." },
          { name: "Instagram", glyph: "◎", connected: operations.instagram.configured, text: operations.instagram.accounts.length ? operations.instagram.accounts.map(a => "@" + a).join(", ") : "Connect a professional account and configure supported accounts to watch." },
          { name: "WordPress", glyph: "W", connected: operations.wordpress.enabled, text: "Review here, send a draft to your connected site, and publish from WordPress." },
        ].map(source => <article key={source.name}><span className="edition-source-glyph">{source.glyph}</span><span className={source.connected ? "edition-connected" : "edition-needs-setup"}>{source.connected ? "Configured" : "Setup needed"}</span><h3>{source.name}</h3><p>{source.text}</p></article>)}</div>
        <div className="edition-schedule"><div><small>Edition schedule</small><h3>{operations.automatic ? `Daily at ${operations.daily_time_utc} UTC` : "Manual refresh"}</h3><p>Source dates use {operations.timezone}. Active editions are revisited hourly; yesterday is checked for late arrivals.</p></div><button type="button" className="edition-primary" disabled={busy || !operations.worker_online} onClick={() => void refresh()}>Refresh now ↻</button></div>
        <p className="edition-hint">{operations.worker_online ? "Daily worker is online." : "Daily worker is offline. Start the worker service to process queued refreshes."}</p>
        {operations.cooldowns.map(c => <p className="edition-message" key={c.provider}>{c.provider} is cooling down until {new Date(c.retry_at * 1000).toLocaleTimeString()}. Intake will resume within its limits.</p>)}
        <h3>Recent editions</h3><div className="edition-run-list">{operations.runs.length ? operations.runs.map(run => <div key={run.id}><span>{new Date(run.created_at).toLocaleString()}</span><strong className={run.status === "completed" ? "edition-connected" : "edition-needs-setup"}>{readable(run.status)}</strong></div>) : <p>Your first refresh will appear here.</p>}</div>
      </div>}
    </dialog>
  </>;
}
