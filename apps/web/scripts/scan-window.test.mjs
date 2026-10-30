import test from "node:test";
import assert from "node:assert/strict";
import { collectionWindow, dateInWindow, scanWindow } from "./scan-window.mjs";

const window = collectionWindow(new Date("2026-10-26T12:00:00Z"));
const recent = "2026-10-25T10:00:00Z";
const older = "2026-10-24T10:00:00Z";
const entry = (id, published_at = recent, extras = {}) => ({ id: String(id), published_at, ...extras });

test("each scan recalculates today and yesterday at India midnight", () => {
  for (const [asOf, start, end] of [
    ["2026-10-26T18:29:59Z", "2026-10-25", "2026-10-26"],
    ["2026-10-26T18:30:00Z", "2026-10-26", "2026-10-27"],
    ["2026-10-27T18:30:00Z", "2026-10-27", "2026-10-28"],
  ]) {
    const current = collectionWindow(new Date(asOf));
    assert.equal(current.window_start, start);
    assert.equal(current.window_end, end);
    assert.equal(dateInWindow(`${start}T00:00:00+05:30`, current), "recent");
    assert.equal(dateInWindow(new Date(Date.parse(`${start}T00:00:00+05:30`) - 1).toISOString(), current), "older");
  }
});

test("calendar windows roll across month, year and leap-day boundaries", () => {
  for (const [asOf, yesterday, today] of [
    ["2026-11-01T00:00:00+05:30", "2026-10-31", "2026-11-01"],
    ["2027-01-01T00:00:00+05:30", "2026-12-31", "2027-01-01"],
    ["2028-03-01T00:00:00+05:30", "2028-02-29", "2028-03-01"],
  ]) {
    const current = collectionWindow(new Date(asOf));
    assert.deepEqual([current.window_start, current.window_end], [yesterday, today]);
  }
});

test("a scan keeps its starting window and leaves later arrivals for the next scan", () => {
  const first = collectionWindow(new Date("2026-10-26T18:29:59Z"));
  const next = collectionWindow(new Date("2026-10-26T18:30:01Z"));
  const arrival = "2026-10-27T00:00:00+05:30";
  assert.equal(dateInWindow(arrival, first), "newer_than_scan");
  assert.equal(dateInWindow(arrival, next), "recent");
  assert.equal(first.window_end, "2026-10-26");
});

async function collect(batches, options = {}) {
  let batch = 0;
  const visited = [];
  const result = await scanWindow({ target: "fixture", window, readBatch: async () => batches[Math.min(batch, batches.length - 1)], advance: async () => { batch++; },
    visit: async item => { visited.push(item.id); return { published_at: item.published_at, qualifying: item.published_at === recent, outcome: item.outcome || "collected" }; }, ...options });
  return { result, visited, batch };
}

test("collects more than the former 12/24 post limits across every loaded page", async () => {
  const posts = Array.from({ length: 48 }, (_, i) => entry(i));
  const { result, visited, batch } = await collect([posts.slice(0, 12), posts.slice(12, 24), posts.slice(24, 36), posts.slice(36), Array.from({ length: 6 }, (_, i) => entry(100 + i, older))]);
  assert.equal(result.status, "complete");
  assert.equal(result.recent, 48);
  assert.equal(result.qualifying, 48);
  assert.equal(visited.length, 54);
  assert.equal(batch, 4);
});
test("old pinned posts never stop discovery before recent posts farther down", async () => {
  const { result, visited } = await collect([Array.from({ length: 9 }, (_, i) => entry(i, older, { pinned: true })), [entry("recent")], Array.from({ length: 6 }, (_, i) => entry(100 + i, older))]);
  assert.equal(result.status, "complete");
  assert.ok(visited.includes("recent"));
});
test("an out-of-order recent post in the same batch resets the old-date boundary", async () => {
  const { result, visited } = await collect([[...Array.from({ length: 6 }, (_, i) => entry(i, older)), entry("new")], [entry("newer")], Array.from({ length: 6 }, (_, i) => entry(100 + i, older))]);
  assert.equal(result.recent, 2);
  assert.ok(visited.includes("newer"));
});
test("a stalled feed is partial and repeating links are checked only once", async () => {
  const { result, visited } = await collect([[entry("one"), entry("one"), entry("two")]]);
  assert.deepEqual(visited, ["one", "two"]);
  assert.equal(result.status, "partial");
  assert.equal(result.stop_reason, "feed_stalled");
});
test("unreadable dates and capture failures keep coverage partial even after reaching old posts", async () => {
  const { result } = await collect([[entry("unknown", null), entry("failed", recent, { outcome: "failed" }), ...Array.from({ length: 6 }, (_, i) => entry(i, older))]]);
  assert.equal(result.status, "partial");
  assert.equal(result.failures, 2);
  assert.equal(result.stop_reason, "date_boundary");
});
test("limits report incomplete coverage instead of successful truncation", async () => {
  assert.equal((await collect([[entry(1)], [entry(2)]], { maxScrolls: 0 })).result.stop_reason, "scroll_limit");
  let clock = 0;
  const { result } = await collect([[entry(1)]], { now: () => clock++, maxMs: 1 });
  assert.equal(result.status, "partial");
  assert.equal(result.stop_reason, "time_limit");
});
test("one failed post does not prevent later eligible posts from being checked", async () => {
  const { result } = await collect([[entry("bad"), entry("good"), ...Array.from({ length: 6 }, (_, i) => entry(i, older))]], {
    visit: async item => { if (item.id === "bad") throw new Error("capture failed"); return { published_at: item.published_at, qualifying: item.id === "good", outcome: "collected" }; },
    onVisitError: async () => ({ outcome: "failed" }),
  });
  assert.equal(result.qualifying, 1);
  assert.equal(result.failures, 1);
  assert.equal(result.status, "partial");
});
