import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRedditTimestamp, redditPublication } from "./reddit-publication.mjs";

const now = new Date("2026-10-26T12:23:15.884Z");
test("live Reddit microsecond timestamps with +0000 qualify as recent posts", () => {
  for (const stamp of ["2026-10-26T12:01:06.117000+0000", "2026-10-26T10:10:39.067000+0000", "2026-10-26T09:30:57.162000+0000"]) {
    const result = redditPublication(stamp, "Asia/Kolkata", now);
    assert.equal(result.reason, undefined);
    assert.match(result.published_at, /^2026-10-26T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
});
test("compact and colon timezone offsets resolve to the same instant", () => {
  const expected = "2026-10-26T10:10:39.067Z";
  for (const stamp of ["2026-10-26T10:10:39.067Z", "2026-10-26T10:10:39.067000+00:00", "2026-10-26T15:40:39.067000+0530", "2026-10-26T15:40:39.067000+05:30", "2026-10-26T06:10:39.067000-0400"]) assert.equal(normalizeRedditTimestamp(stamp), expected);
});
test("today and yesterday use India calendar boundaries, not a rolling 24 hour window", () => {
  assert.ok(redditPublication("2026-10-24T18:30:00.000000+0000", "Asia/Kolkata", now).published_at);
  assert.equal(redditPublication("2026-10-24T18:29:59.999000+0000", "Asia/Kolkata", now).reason, "outside_today_yesterday");
  assert.equal(redditPublication("2026-10-26T12:24:00.000000+0000", "Asia/Kolkata", now).reason, "future_publication");
});
test("missing, relative, impossible and timezone-free dates remain unverified", () => {
  for (const stamp of [null, "", "2 hr. ago", "2026-10-26", "2026-10-26T12:01:06", "2026-02-30T12:00:00Z", "2026-10-26T25:00:00+0000", "2026-10-26T12:00:00+9999"]) assert.equal(redditPublication(stamp, "Asia/Kolkata", now).reason, "date_unverified");
});
