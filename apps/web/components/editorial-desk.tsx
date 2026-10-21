"use client";
import { Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StoryWorkspace, type StoryWorkspaceHandle, type StorySelection } from "@/components/story-workspace";
import { rememberStory, storyDestination } from "@/lib/editorial-flow";
type Run = { id: string; status: string; created_at: string };
type Operations = { automatic: boolean; daily_time_utc: string; timezone: string; worker_online: boolean; reddit: { configured: boolean }; instagram: { configured: boolean; accounts: string[] }; wordpress: { enabled: boolean; site: string }; runs: Run[]; cooldowns: { provider: string; retry_at: number }[] };
type History = { versions: { id: string; created_at: string; preview_url: string }[]; events: { id: number; action: string; actor: string; created_at: string }[] };

export async function editorialRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api/backend/" + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Please check the form and try again.");
  return result;
}
function photo(path: string) { return "/media" + path; }
function readable(value: string) { return value.replaceAll("_", " "); }


export type EditorialDeskHandle = { openStory: () => void };
export function EditorialDesk({ selected, username, resumeStep, onResumeHandled, onEditCollage, onRefresh, ref }: { selected: StorySelection | null; username: string; resumeStep?: "story" | "review" | null; onResumeHandled: () => void; onEditCollage: () => void; onRefresh: () => void; ref?: Ref<EditorialDeskHandle> }) {
  const [tab, setTab] = useState<"story" | "history" | "connections" | null>(null);
  const [initialReview, setInitialReview] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [operations, setOperations] = useState<Operations | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const composer = useRef<StoryWorkspaceHandle>(null);
  const refreshAction = useRef(onRefresh);
  refreshAction.current = onRefresh;
  const lastRuns = useRef("");
  async function close() {
    if (busy) return;
    if (tab === "story" && composer.current && !await composer.current.flush()) return;
    dialog.current?.close(); setTab(null);
  }
  async function editCollage() {
    if (composer.current && !await composer.current.flush()) return;
    dialog.current?.close(); setTab(null);
    if (selected) { rememberStory(username, selected.id, "collage"); window.history.replaceState(null, "", storyDestination(selected.id, "collage")); }
    onEditCollage();
  }
  async function open(next: typeof tab, review = false) {
    if (busy) return;
    setTab(next); setInitialReview(review); setMessage(""); setHistory(null);
    dialog.current?.showModal();
    if (next === "story") return;
    setBusy(true);
    try {
      if (next === "history" && selected) setHistory(await editorialRequest<History>(`cases/${selected.id}/history`));
      else if (next === "connections") setOperations(await editorialRequest<Operations>("operations"));
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  useImperativeHandle(ref, () => ({ openStory: () => { void open("story"); } }));
  useEffect(() => {
    if (resumeStep && selected && username && !dialog.current?.open) { void open("story", resumeStep === "review"); onResumeHandled(); }
  }, [resumeStep, selected?.id, username]);
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
    const poll = setInterval(() => { if (document.visibilityState === "visible") void editorialRequest<Operations>("operations").then(update).catch(() => {}); }, 30000);
    return () => clearInterval(poll);
  }, []);
  async function refresh() {
    setBusy(true);
    try { await editorialRequest("runs/refresh", {}); setOperations(await editorialRequest<Operations>("operations")); setMessage("Refresh queued. You can keep editing while photos are collected."); }
    catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
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
      </div>
    </section>
    <dialog className="edition-dialog" ref={dialog} onCancel={event => { event.preventDefault(); void close(); }}>
      <header><div><small>High Heel Confidential / Editorial studio</small><h2>{tab === "story" ? "The story behind the look." : tab === "history" ? "Every edit, kept." : "A fresh edition. Every day."}</h2></div><button type="button" onClick={() => void close()} aria-label="Close editorial workspace">×</button></header>
      {message && <p className="edition-message" role="status">{message}</p>}
      {busy && <div className="edition-progress" role="progressbar" aria-label="Working" />}
      {tab === "story" && selected && <StoryWorkspace key={selected.id} ref={composer} selected={selected} username={username} initialReview={initialReview} onEditCollage={() => void editCollage()}/>}
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
