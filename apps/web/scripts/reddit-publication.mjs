// Reddit's created-timestamp uses microseconds and compact offsets (+0000).
// Require an explicit timezone, normalize to milliseconds, and keep the instant.
export function normalizeRedditTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = "", offset] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59) return null;
  const zone = offset.toUpperCase() === "Z" ? "Z" : offset.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const normalized = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0").slice(0, 3)}${zone}`;
  const stamp = new Date(normalized);
  return Number.isFinite(+stamp) ? stamp.toISOString() : null;
}

export function redditPublication(value, timezone = "Asia/Kolkata", now = new Date()) {
  const published_at = normalizeRedditTimestamp(value);
  if (!published_at) return { reason: "date_unverified" };
  const published = new Date(published_at);
  if (+published > +now) return { reason: "future_publication" };
  const day = date => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  if (![day(now), day(new Date(+now - 86400000))].includes(day(published))) return { reason: "outside_today_yesterday" };
  return { published_at };
}
