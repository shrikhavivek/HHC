"use client";

import { useEffect, useState } from "react";

type Person = { name: string; handle: string; enabled: boolean };
type Brand = { name: string; handles: string[]; aliases: string[] };
type Config = { enabled: boolean; celebrities: Person[]; brands: Brand[] };
type Run = { status: string; runner_online?: boolean; updated_at?: string; heartbeat?: number; accounts_checked?: number; accounts_total?: number; current_account?: string; dry_run?: boolean; posts_checked?: number; imported?: number; detail?: string; exclusions?: Record<string, number> };
type Post = { id: string; celebrity: string; base_image: string; collage_image?: string | null; photo_count?: number; carousel_complete?: boolean; permalink: string; published_at: string; brands: string[] };

async function request(path: string, body?: object) {
  const response = await fetch(`/api/backend/instagram-browser/${path}`, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) throw new Error("Your session expired. Sign in again.");
    if (response.status === 503) throw new Error("Instagram scanning is unavailable right now. Please try again shortly.");
    throw new Error(typeof data.detail === "string" ? data.detail : "Something went wrong. Please try again.");
  }
  return data;
}

export function InstagramWatchlist({ onOpen }: { onOpen: (caseId: string) => Promise<void> }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [people, setPeople] = useState("");
  const [brands, setBrands] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    request("config").then((value: Config) => {
      if (cancelled) return;
      setConfig(value);
      setPeople(value.celebrities.map(person => `${person.name} | ${person.handle}${person.enabled ? "" : " | off"}`).join("\n"));
      setBrands(value.brands.map(brand => `${brand.name} | ${brand.handles.join(", ")} | ${brand.aliases.join(", ")}`).join("\n"));
    }).catch(caught => { if (!cancelled) setError(caught.message); });
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const [status, feed] = await Promise.all([request("status"), request("posts")]);
        if (!cancelled) { setRun(status); setPosts(feed.results); setLoaded(true); setConnectionError(""); }
      } catch { if (!cancelled) setConnectionError("Unable to update the feed. Please refresh the page."); }
      finally { refreshing = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  async function scan() {
    setScanning(true); setError(""); setMessage("");
    try { setRun(await request("scan", {})); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not start the scan."); }
    finally { setScanning(false); }
  }

  async function save() {
    if (!config) return;
    setBusy(true); setMessage(""); setError("");
    try {
      const split = (text: string) => text.split(",").map(value => value.trim()).filter(Boolean);
      const celebrities = people.split("\n").filter(line => line.trim()).map(line => {
        const [name, handle = "", state = ""] = line.split("|").map(value => value.trim());
        if (state && state !== "off") throw new Error("Use 'off' to pause an account, or leave the third field blank.");
        return { name, handle: handle.replace(/^@/, ""), enabled: state !== "off" };
      });
      const labels = brands.split("\n").filter(line => line.trim()).map(line => {
        const [name, handles = "", aliases = ""] = line.split("|").map(value => value.trim());
        return { name, handles: split(handles).map(handle => handle.replace(/^@/, "")), aliases: split(aliases) };
      });
      const saved = await request("config", { enabled: config.enabled, celebrities, brands: labels });
      setConfig(saved); setMessage("Watchlist saved.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save the watchlist."); }
    finally { setBusy(false); }
  }

  const active = !connectionError && !!run && ["queued", "awaiting_login", "running"].includes(run.status) && Date.now() / 1000 - (run.heartbeat || 0) < 180;
  const awaitingLogin = active && run?.status === "awaiting_login";
  const accounts = config?.celebrities.filter(person => person.enabled).length || 0;
  const visible = posts.filter(post => `${post.celebrity} ${post.brands.join(" ")}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const date = (value: string) => new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const preview = (post: Post) => { const path = post.collage_image || post.base_image; return path.startsWith("/") ? `/media${path}` : path; };
  const statusLabel = !run ? "" : awaitingLogin ? "Waiting for Instagram sign-in" : active ? run.status === "queued" ? "Opening Instagram…" : `Scanning ${run.current_account || "Instagram"}` : run.dry_run ? "Preview complete" : ({ completed: "Scan complete", partial: "Some accounts could not be checked", blocked: "Instagram needs your attention", failed: "Scan stopped", paused: "Scanning paused", cancelled: "Scan cancelled", not_run: "", interrupted: "Scan stopped" }[run.status] || "Scan stopped");
  const statusHint = awaitingLogin ? "Complete sign-in or verification in the Instagram window. Your scan starts automatically; keep that window open."
    : active ? run?.status === "running" ? "Keep the Instagram window open while we collect photos." : "Sign in when the Instagram window opens."
    : run?.dry_run ? "Choose Scan now to collect photos."
    : run?.status === "blocked" ? "Complete any checks in Instagram, then try Scan now again."
    : run?.status === "paused" ? "Enable scanning in Watchlist settings to continue."
    : run?.status === "cancelled" && run.detail?.includes("timed out") ? "Sign-in timed out. Choose Scan now to try again."
    : ["interrupted", "failed", "running", "awaiting_login", "queued"].includes(run?.status || "") ? "Choose Scan now to start again." : "";

  return <section className="web-discovery instagram-watchlist" aria-label="Instagram discovery">
    <header className="instagram-heading"><div><h2>Discover Instagram posts</h2><p>Recent photos with brand or designer credits.</p></div><span className="web-week-badge">Today &amp; yesterday</span></header>
    <div className="web-discovery-content">
      <div className="instagram-scan-bar"><strong>{accounts} watched accounts</strong><button type="button" className="primary" onClick={() => void scan()} disabled={scanning || active || busy || !config}>{scanning || run?.status === "queued" && active ? "Opening Instagram…" : awaitingLogin ? "Waiting for sign-in…" : active ? "Scan in progress…" : "Scan now"}</button></div>
      {statusLabel && !error && !connectionError && <div className="instagram-progress" role="status" aria-live="polite"><strong>{statusLabel}</strong>{active && run?.status === "running" && <span>{run.accounts_checked || 0} of {run.accounts_total || accounts} accounts checked</span>}{statusHint && <p>{statusHint}</p>}</div>}
      {run && !run.runner_online && !active && !error && !connectionError && <p className="web-discovery-note">Instagram scanning is currently unavailable.</p>}
      {(error || connectionError) && <p role="alert" className="web-discovery-error">{error || connectionError}</p>}
      {message && <p role="status">{message}</p>}
      {!!posts.length && <div className="web-results-heading"><strong>Collected photos · {posts.length}</strong></div>}
      {!!posts.length && <label className="instagram-filter">Filter collected photos<input aria-label="Filter collected photos" placeholder="Celebrity or brand" value={filter} onChange={event => setFilter(event.target.value)}/></label>}
      {!loaded ? <p>Loading photos…</p> : !posts.length ? !active && <div className="instagram-empty"><strong>No recent photos yet.</strong>{!statusHint && <p>Choose Scan now to open Instagram and collect photos.</p>}</div> : !visible.length ? <p>No photos match that celebrity or brand.</p> : <div className="web-results-grid">{visible.map(post => <article className="web-result instagram-photo" key={post.id}>
        <img src={preview(post)} alt={`${post.celebrity} — Instagram collage preview`} loading="lazy"/>
        <div className="web-result-meta"><time dateTime={post.published_at}>{date(post.published_at)}</time></div><h3>{post.celebrity}</h3><p>{post.brands.join(", ")}</p><strong>{post.photo_count || 1} {(post.photo_count || 1) === 1 ? "photo" : "photos"}</strong>{!post.carousel_complete && <small>Some photos may be missing.</small>}<a href={post.permalink} target="_blank" rel="noreferrer">View on Instagram ↗</a><button type="button" className="primary" onClick={() => void onOpen(post.id).catch(() => setError("Could not open the draft. Please try again."))}>Open draft</button>
      </article>)}</div>}
      <details className="instagram-settings"><summary>Watchlist settings</summary>{config && <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="instagram-enable"><input type="checkbox" checked={config.enabled} disabled={busy} onChange={event => setConfig({ ...config, enabled: event.target.checked })}/>Enable Instagram scanning</label>
        <label>Celebrity watchlist<textarea aria-label="Celebrity watchlist" value={people} disabled={busy} onChange={event => setPeople(event.target.value)} rows={8} spellCheck={false}/></label>
        <p className="web-discovery-note">One per line: Name | instagram_handle. Add | off to pause an account. Review handles before adding them.</p>
        <label>Recognized brands and designers<textarea aria-label="Recognized brands and designers" value={brands} disabled={busy} onChange={event => setBrands(event.target.value)} rows={7} spellCheck={false}/></label>
        <p className="web-discovery-note">One per line: Brand name | handles separated by commas | alternative names separated by commas.</p>
        <button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : "Save watchlist"}</button>
      </form>}</details>
    </div>
  </section>;
}
