import { normalizeRedditTimestamp } from "./reddit-publication.mjs";

export function collectionWindow(now = new Date(), timezone = "Asia/Kolkata") {
  const day = date => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return { window_start: day(new Date(+now - 86400000)), window_end: day(now), as_of: now.toISOString(), timezone };
}

export function dateInWindow(value, window) {
  const stamp = normalizeRedditTimestamp(value);
  if (!stamp) return "unverified";
  if (Date.parse(stamp) > Date.parse(window.as_of)) return "newer_than_scan";
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: window.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(stamp));
  return day < window.window_start ? "older" : "recent";
}

// Keep the listing in its own tab so visiting a post never resets pagination.
// A stalled feed is incomplete, not evidence that there are no more posts.
export async function scanWindow({ target, window, readBatch, visit, advance, check = async () => {}, onProgress = async () => {}, onVisitError = error => { throw error; }, oldBoundary = 6, maxScrolls = 200, maxMs = 45 * 60 * 1000, now = Date.now }) {
  const coverage = { target, status: "scanning", stop_reason: "", discovered: 0, checked: 0, recent: 0, qualifying: 0, collected: 0, existing: 0, failures: 0, oldest_published_at: null };
  const seen = new Set();
  let oldStreak = 0;
  let stalled = 0;
  const deadline = now() + maxMs;
  const finish = async reason => {
    coverage.stop_reason = reason;
    coverage.status = reason === "date_boundary" && coverage.failures === 0 ? "complete" : "partial";
    await onProgress({ ...coverage });
    return coverage;
  };
  await onProgress({ ...coverage });
  for (let scroll = 0; scroll <= maxScrolls; scroll++) {
    await check();
    if (now() >= deadline) return finish("time_limit");
    const batch = await readBatch();
    const fresh = batch.filter(entry => !seen.has(entry.id));
    stalled = fresh.length ? 0 : stalled + 1;
    for (const entry of fresh) {
      await check();
      if (now() >= deadline) return finish("time_limit");
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      coverage.discovered++;
      // visit always reports its outcome, including excluded and failed posts.
      let result;
      try { result = await visit(entry); }
      catch (error) { result = await onVisitError(error, entry); }
      coverage.checked++;
      const stamp = normalizeRedditTimestamp(result.published_at);
      const date = dateInWindow(stamp, window);
      if (stamp && (!coverage.oldest_published_at || stamp < coverage.oldest_published_at)) coverage.oldest_published_at = stamp;
      if (!entry.pinned) oldStreak = date === "older" ? oldStreak + 1 : 0;
      if (date === "recent") coverage.recent++;
      if (result.qualifying) coverage.qualifying++;
      if (result.outcome === "collected") coverage.collected++;
      if (result.outcome === "existing") coverage.existing++;
      if (date === "unverified" || result.outcome === "failed") coverage.failures++;
      await onProgress({ ...coverage });
    }
    // Evaluate the entire batch: an older pinned/reordered item must not hide a
    // recent item farther down the same loaded batch.
    if (oldStreak >= oldBoundary) return finish("date_boundary");
    if (stalled >= 3) return finish("feed_stalled");
    if (scroll === maxScrolls) return finish("scroll_limit");
    await advance();
  }
}
