"use client";

import { FormEvent, useState } from "react";

type WebPost = {
  title: string;
  description: string;
  publisher: string;
  platform: string;
  permalink: string;
  published_at: string;
  published_date: string;
  date_precision: "day" | "time";
  date_evidence: string;
  existing_case_id?: string | null;
};
type Discovery = {
  results: WebPost[];
  week_start: string;
  week_end: string;
  timezone: string;
  checked: number;
  excluded: number;
  warnings: string[];
  source?: "instagram" | "web";
  search_status?: "complete" | "partial";
  rejected?: { url: string; reason: string; code: string }[];
};

function displayDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}

async function discoveryRequest(path: string, payload: Record<string, unknown>) {
  const response = await fetch(`/api/backend/discovery/web/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Web discovery could not complete this request. Please try again.");
  return data;
}

export function WebDiscovery({ onImported }: { onImported: (caseId: string) => Promise<void> }) {
  const [source, setSource] = useState<"instagram" | "web">("instagram");
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = String(new FormData(event.currentTarget).get("query") || "").trim();
    setBusy("search"); setError(""); setNotice(""); setDiscovery(null);
    try {
      const result: Discovery = await discoveryRequest("search", { query, source });
      setDiscovery(result);
      setNotice(`${result.search_status === "partial" ? "Search incomplete. " : ""}${result.results.length} verified ${source === "instagram" ? "today/yesterday Instagram posts" : "current-week sources"} in the available results. ${result.checked} pages checked.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The web search service is unavailable. Please retry.");
    } finally { setBusy(null); }
  }

  async function importPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form).entries());
    const url = String(fields.source_url);
    setBusy(url); setError(""); setNotice("");
    try {
      const result = await discoveryRequest("import", fields);
      setDiscovery(current => current ? { ...current, results: current.results.map(post => post.permalink === url ? { ...post, existing_case_id: result.case_id } : post) } : current);
      setNotice("Source imported with its publication date. Review attribution and image rights before publishing.");
      await onImported(result.case_id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This source could not be imported.");
    } finally { setBusy(null); }
  }

  return <details className="web-discovery">
    <summary><span><small>PUBLIC DISCOVERY · NO ACCOUNT CONNECTION</small><strong>{source === "instagram" ? "Discover Instagram posts" : "Discover looks from the web"}</strong></span><span className="web-week-badge">{source === "instagram" ? "Today & yesterday" : "Current week only"}</span></summary>
    <div className="web-discovery-content">
      <p>{source === "instagram" ? "This optional public-web search is separate from the daily browser watchlist above. Only Instagram posts published today or yesterday are shown; public search may be unavailable." : "Browse publicly accessible fashion coverage published this calendar week (Monday–Sunday)."} Dates use Asia/Kolkata.</p>
      <form className="web-search-form" onSubmit={search}>
        <label className="web-source-select">Search source<select aria-label="Search source" value={source} disabled={!!busy} onChange={event => { setSource(event.target.value as "instagram" | "web"); setDiscovery(null); setError(""); setNotice(""); }}><option value="instagram">Instagram posts</option><option value="web">Fashion websites</option></select></label>
        <label>Celebrity, designer, brand or event<input name="query" maxLength={180} placeholder="e.g. Alia Bhatt or Sabyasachi" disabled={!!busy}/></label>
        <button type="submit" className="primary" disabled={!!busy}>{busy === "search" ? "Checking publication dates…" : source === "instagram" ? "Find Instagram posts" : "Discover this week"}</button>
      </form>
      <p className="web-discovery-note">{source === "instagram" ? "Leave the name blank to search Bollywood fashion posts. Only Instagram results are included—not news articles. Coverage depends on public access and search indexing; excluded posts are explained below." : "Leave the search blank to browse fashion sources. Public publisher feeds are checked alongside web search."}</p>
      {error && <p className="web-discovery-error" role="alert">{error}</p>}
      <p role="status" aria-live="polite">{busy === "search" ? "Browsing public sources and verifying dates. This may take a minute." : busy ? "Rechecking the source date and preparing its editable collage…" : notice}</p>
      {discovery && <section aria-label="Dated discovery results">
        <div className="web-results-heading"><strong>{source === "instagram" ? "Today & yesterday · from " : "Week beginning "}{displayDate(discovery.week_start)}</strong><span>{discovery.timezone} · {discovery.excluded} pages excluded</span></div>
        {discovery.warnings.map(warning => <p className="web-discovery-note" key={warning}>{warning}</p>)}
        {!discovery.results.length && <p>{source === "instagram" ? "No verifiable recent Instagram posts were found. Posts may be unindexed, outside today/yesterday, or inaccessible without signing in." : "No accessible sources with a verified current-week publication date were found. Try another search."}</p>}
        {!!discovery.rejected?.length && <details className="web-exclusions"><summary>Why were some posts excluded?</summary><ul>{[["outside_week", "Outside the selected date window or future-dated"], ["date_unverified", "Original publication date could not be verified"], ["unavailable", "Public page or media unavailable"]].map(([code, label]) => { const count = discovery.rejected!.filter(item => item.code === code).length; return count ? <li key={code}>{label}: {count}</li> : null; })}</ul></details>}
        <div className="web-results-grid">{discovery.results.map(post => <article className="web-result" key={post.permalink}>
          <div className="web-result-meta"><span>{post.publisher} · {post.platform}</span><time dateTime={post.published_at}>Published {displayDate(post.published_date)}</time></div>
          <h3>{post.title}</h3><p>{post.description}</p>
          <small>Source date confirmed from {post.date_evidence}{post.date_precision === "day" ? " · Publication time not supplied" : ""}. This is the page’s publication date, not necessarily the outfit’s appearance date.</small>
          <a href={post.permalink} target="_blank" rel="noreferrer">Read original source ↗</a>
          {post.existing_case_id ? <p className="web-imported">Already in your editorial desk</p> : <form onSubmit={importPost}>
            <input type="hidden" name="source_url" value={post.permalink}/>
            <details><summary>Add optional outfit context</summary><label>Celebrity<input name="celebrity" maxLength={180} placeholder="If the source does not name the person clearly" disabled={!!busy}/></label><label>Designer<input name="designer" maxLength={180} placeholder="Leave blank if unconfirmed" disabled={!!busy}/></label></details>
            <button type="submit" className="ghost" disabled={!!busy}>{busy === post.permalink ? "Importing…" : "Import to editorial desk"}</button>
          </form>}
        </article>)}</div>
      </section>}
      {source === "web" && <details className="web-url-check"><summary>Already have a public article or post URL?</summary><form onSubmit={importPost}>
        <p>The publication date is checked directly on the page again before import. Search snippets and “last updated” dates do not qualify.</p>
        <label>Public source URL<input name="source_url" type="url" required maxLength={2000} placeholder="https://…" disabled={!!busy}/></label>
        <div className="edition-field-row"><label>Celebrity (optional)<input name="celebrity" maxLength={180} disabled={!!busy}/></label><label>Designer (optional)<input name="designer" maxLength={180} disabled={!!busy}/></label></div>
        <button type="submit" className="ghost" disabled={!!busy}>Verify date &amp; import</button>
      </form></details>}
    </div>
  </details>;
}
