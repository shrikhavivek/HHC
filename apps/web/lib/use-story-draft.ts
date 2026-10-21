"use client";
import { useEffect, useRef, useState } from "react";

export type Story = { title: string; body: string; alt_text: string; credits: string; category_ids: number[]; tag_ids: number[]; revision: number; reviewed_collage_id: string | null; wordpress_post_id?: number; sync_state: string };
const fields = (story: Story) => ({ title: story.title, body: story.body, alt_text: story.alt_text, credits: story.credits, category_ids: story.category_ids, tag_ids: story.tag_ids, reviewed_collage_id: story.reviewed_collage_id });
const signature = (story: Story) => JSON.stringify(fields(story));
class DraftError extends Error { constructor(message: string, public status = 0) { super(message); } }

export function useStoryDraft(caseId: string, username: string) {
  const key = `hhc:draft:${username}:${caseId}`;
  const [story, setStory] = useState<Story | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const current = useRef<Story | null>(null);
  const server = useRef<Story | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);
  const blocked = useRef(false);
  const mounted = useRef(false);
  function keep(value: Story) {
    try { sessionStorage.setItem(key, JSON.stringify({ baseRevision: value.revision, story: fields(value) })); } catch { /* beforeunload still protects unsaved work */ }
  }
  function clear() { try { sessionStorage.removeItem(key); } catch {} }
  async function fetchStory(body?: object): Promise<Story> {
    const response = await fetch(`/api/backend/cases/${caseId}/story`, { method: body ? "POST" : "GET", cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok) throw new DraftError(response.status === 401 ? "Your session expired. Sign in again to save your edits." : typeof data.detail === "string" ? data.detail : "Your changes could not be saved. Please try again.", response.status);
    return data;
  }
  function failure(caught: unknown) {
    const err = caught instanceof DraftError ? caught : new DraftError("Your changes could not be saved. Check your connection and retry.");
    if (mounted.current) { setError(err.message); setExpired(err.status === 401); }
    return false;
  }
  useEffect(() => {
    mounted.current = true;
    void fetchStory().then(data => {
      if (!mounted.current) return;
      server.current = data;
      let value = data;
      try {
        const cached = JSON.parse(sessionStorage.getItem(key) || "null");
        const draft = cached?.story;
        if (draft && [draft.title, draft.body, draft.alt_text, draft.credits].every(value => typeof value === "string") && Array.isArray(draft.category_ids) && Array.isArray(draft.tag_ids)) {
          value = { ...data, ...fields({ ...data, ...draft }) };
          if (signature(value) !== signature(data)) {
            setRecovered(true); setDirty(true);
            blocked.current = cached.baseRevision !== data.revision;
            setConflict(blocked.current);
            if (blocked.current) setError("A newer version is saved. Choose which edits to keep before continuing.");
          } else clear();
        }
      } catch { /* Ignore invalid recovery data. */ }
      current.current = value; setStory(value);
    }).catch(failure).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [caseId, username]);

  function change(patch: Partial<Story>) {
    if (!current.current) return;
    const value = { ...current.current, ...patch };
    current.current = value; setStory(value); keep(value);
    setDirty(!server.current || signature(value) !== signature(server.current));
    if (!blocked.current && !expired) setError("");
  }
  async function saveOne(): Promise<boolean> {
    if (pending.current) return pending.current;
    if (blocked.current || !current.current || !server.current) return false;
    if (signature(current.current) === signature(server.current) && server.current.revision > 0) { clear(); return true; }
    const snapshot = current.current;
    setSaving(true);
    const task = (async () => {
      try {
        const result = await fetchStory({ ...fields(snapshot), expected_revision: snapshot.revision });
        server.current = result;
        // Preserve typing that happened while this request was in flight.
        const value = { ...result, ...fields(current.current || snapshot) };
        current.current = value;
        const remains = signature(value) !== signature(result);
        if (remains) keep(value); else clear();
        if (mounted.current) { setStory(value); setDirty(remains); setError(""); setRecovered(false); }
        return true;
      } catch (caught) {
        if (caught instanceof DraftError && caught.status === 409) {
          blocked.current = true;
          if (mounted.current) setConflict(true);
        }
        return failure(caught);
      } finally { pending.current = null; if (mounted.current) setSaving(false); }
    })();
    pending.current = task;
    return task;
  }
  async function flush() {
    if (pending.current && !await pending.current) return false;
    while (current.current && server.current && (signature(current.current) !== signature(server.current) || server.current.revision === 0)) {
      if (!await saveOne()) return false;
    }
    return Boolean(current.current && !blocked.current);
  }
  async function resolveConflict(useLocal: boolean) {
    try {
      const latest = await fetchStory();
      server.current = latest;
      const value = useLocal && current.current ? { ...latest, ...fields(current.current) } : latest;
      current.current = value; setStory(value); blocked.current = false; setConflict(false); setError(""); setExpired(false);
      setDirty(signature(value) !== signature(latest));
      if (useLocal) keep(value); else clear();
    } catch (caught) { failure(caught); }
  }
  useEffect(() => {
    if (!dirty || saving || loading || error || conflict) return;
    const timer = setTimeout(() => { void saveOne(); }, 900);
    return () => clearTimeout(timer);
  }, [story, dirty, saving, loading, error, conflict]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return { story, loading, saving, dirty, error, expired, conflict, recovered, change, flush, resolveConflict };
}
