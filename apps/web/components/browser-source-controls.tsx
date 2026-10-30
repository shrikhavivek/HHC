"use client";

import { useEffect, useRef, useState } from "react";

type Provider = "instagram" | "reddit";
type CoverageTarget = { target: string; status: string; stop_reason?: string; checked?: number; qualifying?: number; collected?: number; existing?: number; failures?: number };
type Run = { status: string; run_id?: string; runner_online?: boolean; detail?: string; heartbeat?: number; updated_at?: string; posts_checked?: number; imported?: number; exclusions?: Record<string, number>; coverage?: { window_start: string; window_end: string; as_of: string; targets: CoverageTarget[] } | null };
const coverageReasons: Record<string, string> = { date_boundary: "Reached posts older than yesterday", feed_stalled: "The source stopped loading more posts", time_limit: "Scan time limit reached", scroll_limit: "Source kept loading without reaching yesterday", account_check_failed: "Account could not be checked" };
const exclusionLabels: Record<string, string> = {
  outside_today_yesterday: "Older than yesterday", date_unverified: "Publication date could not be verified", future_publication: "Publication date is in the future",
  title_unverified: "Post title could not be read", outside_date_window_or_unverified: "Outside the date window or date unreadable (previous scan)",
  reel_or_video: "Reels or videos", no_recognized_brand: "No recognized brand or designer", already_imported: "Already collected",
  post_capture_failed: "Photo capture failed", incomplete_carousel: "Incomplete photo carousel", individual_subject_unresolved: "Person could not be identified",
  no_brand_credit: "No brand or designer credit", newer_than_scan: "Published after this scan started; included in the next scan",
};
const providers: { id: Provider; name: string; description: string }[] = [
  { id: "instagram", name: "Instagram", description: "Collect recent photo posts from your celebrity watchlist." },
  { id: "reddit", name: "Reddit", description: "Collect recent photo posts from r/BollywoodFashion." },
];
const active = (run?: Run) => !!run && ["queued", "awaiting_login", "awaiting_attention", "running"].includes(run.status) && Date.now() / 1000 - (run.heartbeat || 0) < 180;

async function request(provider: Provider, path: string, body?: object): Promise<Run> {
  const response = await fetch(`/api/backend/${provider}-browser/${path}`, { method: body ? "POST" : "GET", cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? "Your studio session expired. Sign in again." : typeof data.detail === "string" ? data.detail : "Could not open the source. Please try again.");
  return data;
}

export function BrowserSourceControls({ onCollected }: { onCollected: () => Promise<void> }) {
  const [runs, setRuns] = useState<Partial<Record<Provider, Run>>>({});
  const [errors, setErrors] = useState<Partial<Record<Provider, string>>>({});
  const [busy, setBusy] = useState<Partial<Record<Provider, boolean>>>({});
  const refreshDesk = useRef(onCollected);
  refreshDesk.current = onCollected;
  const previous = useRef<Partial<Record<Provider, { runId?: string; imported: number }>>>({});

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        await Promise.all(providers.map(async ({ id }) => {
          try {
            const run = await request(id, "status");
            if (cancelled) return;
            setRuns(current => ({ ...current, [id]: run }));
            const last = previous.current[id];
            previous.current[id] = { runId: run.run_id, imported: run.imported || 0 };
            if ((run.imported || 0) > 0 && (!last || last.runId !== run.run_id || last.imported < (run.imported || 0))) await refreshDesk.current();
          } catch { if (!cancelled) setErrors(current => ({ ...current, [id]: "Unable to check collection status. Refresh the page to retry." })); }
        }));
      } finally { refreshing = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  async function connect(provider: Provider) {
    setBusy(current => ({ ...current, [provider]: true }));
    setErrors(current => ({ ...current, [provider]: "" }));
    try { setRuns(current => ({ ...current, [provider]: undefined })); const run = await request(provider, "scan", {}); setRuns(current => ({ ...current, [provider]: run })); }
    catch (error) { setErrors(current => ({ ...current, [provider]: error instanceof Error ? error.message : "Could not open the source." })); }
    finally { setBusy(current => ({ ...current, [provider]: false })); }
  }

  return <section className="browser-source-panel" aria-labelledby="browser-sources-title">
    <header><div><small>LIVE SOURCES</small><h2 id="browser-sources-title">Sign in. Collect photos. Keep editing.</h2><p>Sign in directly on the source website in the Edge window that opens. Keep it open while photos are captured; your drafts appear here automatically.</p></div></header>
    <div className="browser-source-grid">{providers.map(({ id, name, description }) => {
      const run = runs[id];
      const running = active(run);
      const stateLabel = !run ? "Checking status…" : running
        ? ({ queued: "Opening window", awaiting_attention: "Needs your attention", awaiting_login: "Sign-in needed", running: "Collecting" }[run.status] || "Collecting")
        : ({ failed: "Last attempt failed", blocked: "Source needs attention", cancelled: "Collection stopped", interrupted: "Collection interrupted", completed: "Collection complete", partial: "Partly collected" }[run.status] || (run.runner_online ? "Ready to start" : "Collector offline"));
      const detail = run?.detail?.replace(/\u001b\[[0-9;]*m/g, "").split("Call log:")[0].trim();
      const readableDetail = detail && /page\.goto|net::ERR_/i.test(detail)
        ? running ? `${name} could not load. Check the open ${name} window and refresh or complete sign-in there.` : `The previous attempt could not load ${name}'s page. Choose the sign-in button above to start a fresh attempt.`
        : detail;
      const label = busy[id] || running && run?.status === "queued" ? `Opening ${name}…` : running && run?.status === "awaiting_attention" ? `Check the ${name} window…` : running && run?.status === "awaiting_login" ? `Waiting for ${name} sign-in…` : running ? `Collecting ${name} photos…` : `Sign in to ${name} & collect photos`;
      return <article key={id} aria-label={`${name} browser intake`}>
        <div className="browser-source-title"><h3>{name}</h3><span>{stateLabel}</span></div>
        <p>{description}</p>
        <button type="button" className="primary" onClick={() => void connect(id)} disabled={!!busy[id] || running}>{label} <span aria-hidden="true">↗</span></button>
        <div className="browser-source-status" role="status" aria-live="polite">
          {readableDetail && <p>{readableDetail}</p>}
          {!running && run?.updated_at && <small>Last attempt: {new Date(run.updated_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</small>}
          {running && run?.status === "awaiting_login" && <p>Enter your credentials in the {name} window. Collection continues automatically after sign-in.</p>}
          {run && run.status !== "not_run" && <small>{run.posts_checked || 0} posts checked · {run.imported || 0} posts collected</small>}
          {Object.entries(run?.exclusions || {}).filter(([, count]) => count > 0).map(([reason, count]) => <p key={reason}>{count} · {exclusionLabels[reason] || reason.replaceAll("_", " ")}</p>)}
          {run?.coverage && <details className="source-coverage"><summary>Coverage: {run.coverage.targets.filter(target => target.status === "complete").length} / {run.coverage.targets.length} sources checked through yesterday</summary>
            <p>{run.coverage.window_start} to {run.coverage.window_end} · India time · Posts available when the scan started.</p>
            {run.coverage.targets.map(target => <p key={target.target}><strong>{target.target}</strong> — {target.status === "not_started" ? "Waiting to scan" : target.status === "scanning" ? "Scanning" : target.status === "complete" ? "Date boundary reached" : "Incomplete"}. {target.checked || 0} checked · {target.qualifying || 0} qualify · {target.collected || 0} collected · {target.existing || 0} already saved{target.stop_reason ? ` · ${coverageReasons[target.stop_reason] || target.stop_reason.replaceAll("_", " ")}` : ""}{!!target.failures && ` · ${target.failures} unresolved posts`}</p>)}
          </details>}
          {!running && run && !run.runner_online && <p>Start the HHC Browser Requests task on this computer to open the sign-in window.</p>}
        </div>
        {errors[id] && <p className="web-discovery-error" role="alert">{errors[id]}</p>}
      </article>;
    })}</div>
    <p className="web-discovery-note">Today and yesterday’s photo posts with brand or designer credits. Reels and videos are excluded. Scans continue through the date window; blocked pages, unreadable posts and stalled feeds are reported as incomplete. Keep both source tabs open during collection.</p>
  </section>;
}
