"use client";

import { FormEvent, useEffect, useState } from "react";

type Lead = { permalink: string; caption: string; title?: string; author?: string; hashtag?: string; published_at: string | null };
type Search = { status: string; detail: string; results: Lead[]; hashtags: string[]; match_mode: "all"; tags_checked?: number; posts_checked?: number; exclusions?: Record<string, number>; warnings?: string[] };
type Plan = {
  hashtags: { tag: string; reason: string; url: string }[];
  google_queries: { query: string; url: string }[];
  excluded_celebrity: string;
  excluded_terms: string[];
  default_hashtags: string[];
  context_fingerprint: string;
  max_selected: number;
  google_configured: boolean;
  search: Search | null;
  google_search: Search | null;
};

async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/backend/instagram-browser/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Instagram research could not complete. Please retry.");
  return data;
}

export function InstagramHashtagResearch({ caseId, onAddSource }: { caseId: string; onAddSource: (url: string) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState<"instagram" | "google" | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const path = `cases/${caseId}/hashtags`;
  const active = ["queued", "running"].includes(plan?.search?.status || "");
  const selectedTags = [...new Set(tags.split(/[\s,]+/).map(value => value.replace(/^#/, "").toLowerCase()).filter(Boolean))];
  const googleQuery = plan && selectedTags.length ? 'site:instagram.com/p/ ' + selectedTags.map(tag => `"#${tag}"`).join(" ") + " " + [plan.excluded_celebrity, ...plan.excluded_terms].map(term => `-"${term}"`).join(" ") : "";
  const googleUrl = googleQuery ? "https://www.google.com/search?" + new URLSearchParams({ q: googleQuery }).toString() : "";
  function matchesSelection(data: Search) { return data.match_mode === "all" && JSON.stringify([...data.hashtags].sort()) === JSON.stringify([...selectedTags].sort()); }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void request(path, undefined, controller.signal).then((data: Plan) => {
      const savedTags = data.search?.match_mode === "all" ? data.search.hashtags : data.google_search?.match_mode === "all" ? data.google_search.hashtags : data.default_hashtags;
      setPlan(data); setTags(savedTags.map(tag => `#${tag}`).join(" "));
    }).catch(caught => { if (!controller.signal.aborted) setError(caught.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void request(path, undefined, controller.signal).then(setPlan).catch(caught => {
        if (!controller.signal.aborted) setError(caught.message);
      });
    }, 10000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [active, path]);

  async function search(mode: "instagram" | "google") {
    if (!plan) return;
    const selected = selectedTags;
    if (!selected.length || selected.length > plan.max_selected) {
      setError(`Choose between 1 and ${plan.max_selected} hashtags.`); return;
    }
    setBusy(mode); setError("");
    try {
      const result: Search = await request(`${path}/${mode === "google" ? "google" : "search"}`, {
        context_fingerprint: plan.context_fingerprint,
        hashtags: selected,
      });
      setPlan(current => current ? { ...current, [mode === "google" ? "google_search" : "search"]: result } : current);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Search could not complete."); }
    finally { setBusy(null); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void search("instagram"); }

  return <details className="web-discovery instagram-hashtag-research">
    <summary><span><small>OUTFIT RESEARCH</small><strong>Find similar looks on Instagram</strong></span></summary>
    <div className="web-discovery-content">
      <p>Search the designer, maker, garment and fabric to find other wearers or similar pieces. Earlier posts are included in this research.</p>
      {loading && <p role="status">Preparing outfit keywords…</p>}
      {error && <p className="web-discovery-error" role="alert">{error}</p>}
      {!loading && !plan && <button type="button" className="ghost" onClick={() => setAttempt(value => value + 1)}>Reload research</button>}
      {plan && <>
        <p className="web-discovery-note">Excluded from the hashtags: <strong>{plan.excluded_celebrity}</strong>. Google queries also exclude this name. Reposts can still appear; compare each photo with the original.</p>
        <div className="hashtag-suggestions">{plan.hashtags.map(item => <div key={item.tag}>
          <a href={item.url} target="_blank" rel="noreferrer" title={item.reason}>#{item.tag} ↗</a>
          <button type="button" aria-label={`Add ${item.tag} to search`} disabled={!!busy || active} onClick={() => setTags(current => [...new Set([...current.split(/[\s,]+/).filter(Boolean), `#${item.tag}`])].join(" "))}>+</button>
        </div>)}</div>
        {!plan.hashtags.length && <p>Use Correct the person, designer or event to add a designer or garment description and prepare searches.</p>}
        <form className="hashtag-search-form" onSubmit={submit}>
          <label>Hashtags to search <small>All selected hashtags must appear in the post; up to {plan.max_selected}</small><input aria-label="Hashtags to search" value={tags} onChange={event => setTags(event.target.value)} maxLength={500} placeholder="#sabyasachi #silksaree" disabled={!!busy || active}/></label>
          <button className="primary" type="submit" disabled={!!busy || active || !tags.trim()}>{busy === "instagram" ? "Queuing search…" : active ? "Instagram search running…" : "Search signed-in Instagram"}</button>
        </form>
        <p className="web-discovery-note">Results here must match every selected hashtag (AND). Posts missing any hashtag are excluded. Individual Instagram links preview one hashtag; the collector checks the full combination.</p>
        {!!googleQuery && <section className="hashtag-google" aria-label="Google searches for this outfit">
          <strong>Search Instagram posts through Google</strong>
          <p>This Google query uses the same hashtag combination. Results brought here must have every hashtag confirmed in the original post caption.</p>
          <a href={googleUrl} target="_blank" rel="noreferrer">{googleQuery} ↗</a>
          <button type="button" className="ghost" disabled={!!busy || !plan.google_configured} onClick={() => void search("google")}>{busy === "google" ? "Searching Google…" : "Get Google results here"}</button>
          {!plan.google_configured && <p className="web-discovery-note">Open the Google links to search now. Bringing Google results into the studio requires the search connection to be configured.</p>}
        </section>}
        {[{ label: "Instagram hashtag results", data: plan.search }, { label: "Google results", data: plan.google_search }].map(({ label, data }) => data && (matchesSelection(data) ? <section className="hashtag-results" key={label} aria-label={label}>
          <div role="status"><strong>{label} · {data.status.replaceAll("_", " ")}</strong><p>{data.detail}</p>
            {data.posts_checked !== undefined && <p>{data.tags_checked || 0} hashtags and {data.posts_checked} posts checked.</p>}
          </div>
          {data.warnings?.map(warning => <p key={warning}>{warning}</p>)}
          {!!data.exclusions && <details className="web-exclusions"><summary>Excluded posts</summary><ul>{Object.entries(data.exclusions).filter(([, count]) => count > 0).map(([reason, count]) => <li key={reason}>{reason.replaceAll("_", " ")}: {count}</li>)}</ul></details>}
          {!data.results.length && !["queued", "running"].includes(data.status) && <p>No reviewable leads were returned. Try another garment hashtag or open a Google search above.</p>}
          <div className="web-results-grid">{data.results.map(lead => <article className="web-result" key={lead.permalink}>
            <h3>{lead.title || `@${lead.author}`}</h3>
            <span>Matches all: {data.hashtags.map(tag => `#${tag}`).join(" + ")}</span>
            <p>{lead.caption || "Open the original post to review this look."}</p>
            <small>{lead.published_at ? `Post date: ${new Date(lead.published_at).toLocaleDateString()}` : "Publication date needs review"}</small>
            <a href={lead.permalink} target="_blank" rel="noreferrer">Review Instagram post ↗</a>
            <button type="button" className="ghost" onClick={() => onAddSource(lead.permalink)}>Add a credited photo</button>
            <small>Research lead. Confirm the garment, source and usage rights before adding a photo.</small>
          </article>)}</div>
        </section> : <p key={label} className="web-discovery-note">{label}: run a new search to apply the current hashtag combination.</p>))}
      </>}
    </div>
  </details>;
}
