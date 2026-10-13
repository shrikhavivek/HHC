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
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "The Instagram service could not complete this request.");
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
      } catch { if (!cancelled) setConnectionError("Live updates unavailable. Check that the local app is running; displayed results may be out of date."); }
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
      setConfig(saved); setMessage("Watchlist saved. Scan now uses all enabled accounts in this saved list.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save the watchlist."); }
    finally { setBusy(false); }
  }

  const active = !connectionError && !!run && ["queued", "running"].includes(run.status) && Date.now() / 1000 - (run.heartbeat || 0) < 180;
  const accounts = config?.celebrities.filter(person => person.enabled).length || 0;
  const visible = posts.filter(post => `${post.celebrity} ${post.brands.join(" ")}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const date = (value: string) => new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const preview = (post: Post) => { const path = post.collage_image || post.base_image; return path.startsWith("/") ? `/media${path}` : path; };
  const statusLabel = !run ? "Connecting to local collector" : active ? run.status === "queued" ? "Scan queued — opening browser shortly" : `Scanning ${run.current_account || "Instagram"}` : run.dry_run || run.detail?.startsWith("Read-only trial.") ? "Previous check was a preview — run a live scan" : ({ completed: "Scan complete", partial: "Scan incomplete — some posts could not be checked", blocked: "Instagram needs your attention", failed: "Scan could not finish", paused: "Intake paused", not_run: "Ready for your first scan", interrupted: "Scan interrupted" }[run.status] || "Scan interrupted");

  return <section className="web-discovery instagram-watchlist" aria-label="Instagram discovery">
    <header className="instagram-heading"><div><small>YOUR DAILY FASHION FEED</small><h2>Discover Instagram posts</h2><p>Photo posts with brand or designer credits, collected from your saved celebrity watchlist.</p></div><span className="web-week-badge">Today &amp; yesterday</span></header>
    <div className="web-discovery-content">
      <div className="instagram-scan-bar"><div><strong>{accounts} watched accounts</strong><p>Daily at 9:00 AM IST · Signed-in Instagram browser · No public-web search</p></div><button type="button" className="primary" onClick={() => void scan()} disabled={scanning || active || busy || !config}>{scanning ? "Requesting scan…" : active ? "Scan in progress…" : "Scan now"}</button></div>
      <div className="instagram-progress" role="status" aria-live="polite"><strong>{statusLabel}</strong>{run?.updated_at && <span>{run.accounts_checked || 0}/{run.accounts_total || accounts} accounts checked · {run.posts_checked || 0} posts checked · {run.imported || 0} imported · Updated {date(run.updated_at)} IST</span>}{active && <p>Qualifying photos appear below automatically. You can keep using the editor.</p>}</div>
      {run && !run.runner_online && !active && <p className="web-discovery-note">Local collector offline. Keep this computer awake and signed in with Docker running. Windows Task Scheduler → HHC Instagram Requests → Run.</p>}
      {run?.status === "blocked" && <p className="web-discovery-error">Open the HHC Instagram browser and complete Instagram’s sign-in or verification yourself, close that window, then choose Scan now. No access restrictions are bypassed.</p>}
      {(error || connectionError) && <p role="alert" className="web-discovery-error">{error || connectionError}</p>}
      {message && <p role="status">{message}</p>}
      <div className="web-results-heading"><strong>Collected Instagram photos · {posts.length}</strong><span>Publication dates in Asia/Kolkata · Reels excluded</span></div>
      {!!posts.length && <label className="instagram-filter">Filter collected photos<input aria-label="Filter collected photos" placeholder="Celebrity or brand" value={filter} onChange={event => setFilter(event.target.value)}/></label>}
      {!loaded ? <p>Loading collected photos…</p> : !posts.length ? <div className="instagram-empty"><strong>{active ? "Checking the watchlist for eligible photos…" : "No qualifying photos collected for today or yesterday yet."}</strong><p>{active ? "Only dated photo posts with a recognized brand or designer will appear here." : "Choose Scan now to check all enabled accounts and prepare editable drafts. Older posts and reels are not included."}</p></div> : !visible.length ? <p>No collected photos match that celebrity or brand.</p> : <div className="web-results-grid">{visible.map(post => <article className="web-result instagram-photo" key={post.id}>
        <img src={preview(post)} alt={`${post.celebrity} — Instagram collage preview`} loading="lazy"/>
        <div className="web-result-meta"><time dateTime={post.published_at}>Published {date(post.published_at)} IST</time></div><h3>{post.celebrity}</h3><p>Mentioned or tagged: {post.brands.join(", ")}</p><strong>{post.photo_count || 1} {(post.photo_count || 1) === 1 ? "photo" : "photos"} collected · {post.carousel_complete ? "Carousel checked" : "Gallery may be incomplete"}</strong><small>Draft ready · Verify outfit attribution and image rights</small><a href={post.permalink} target="_blank" rel="noreferrer">View Instagram post ↗</a><button type="button" className="primary" onClick={() => void onOpen(post.id).catch(() => setError("Could not open the draft. Please try again."))}>Open editable draft</button>
      </article>)}</div>}
      <details className="web-exclusions instagram-settings"><summary>Scan details &amp; skipped posts</summary><p>{run?.detail || "No completed scan yet."}</p><ul>{Object.entries(run?.exclusions || {}).map(([reason, count]) => <li key={reason}>{reason.replaceAll("_", " ")}: {count}</li>)}</ul><p>Coverage is limited to the saved watchlist, not every Bollywood account. Each scan checks up to 12 post links per account and captures photo slides from the same carousel (up to 20 slides). Video slides are skipped; incomplete galleries are labelled.</p></details>
      <details className="instagram-settings"><summary>Watchlist settings</summary><p>Save changes before scanning. Recognized designer or brand mentions qualify; photographer, stylist and friend tags alone do not.</p>{config && <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="instagram-enable"><input type="checkbox" checked={config.enabled} disabled={busy} onChange={event => setConfig({ ...config, enabled: event.target.checked })}/>Enable daily Instagram intake</label>
        <label>Celebrity watchlist<textarea aria-label="Celebrity watchlist" value={people} disabled={busy} onChange={event => setPeople(event.target.value)} rows={8} spellCheck={false}/></label>
        <p className="web-discovery-note">One per line: Name | instagram_handle. Add | off to pause an account. Review handles before adding them.</p>
        <label>Recognized brands and designers<textarea aria-label="Recognized brands and designers" value={brands} disabled={busy} onChange={event => setBrands(event.target.value)} rows={7} spellCheck={false}/></label>
        <p className="web-discovery-note">One per line: Brand name | handles separated by commas | alternative names separated by commas.</p>
        <button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : "Save watchlist"}</button>
      </form>}</details>
      <p className="web-discovery-note">Collection requires this Windows user signed in, the computer awake, Docker running and a valid Instagram session. Access restrictions stop the scan. Drafts require editorial review; nothing is auto-published.</p>
    </div>
  </section>;
}
