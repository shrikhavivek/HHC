export function postIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/(?:([A-Za-z0-9._]+)\/)?(p|reel)\/([A-Za-z0-9_-]+)\/?$/);
    return match ? { owner: match[1]?.toLowerCase(), type: match[2], shortcode: match[3] } : null;
  } catch { return null; }
}

export function recentPost(value, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value || "")) return false;
  const stamp = new Date(value);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const today = formatter.format(now);
  const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  return Number.isFinite(stamp.getTime()) && stamp <= now && [today, yesterday].includes(formatter.format(stamp));
}

export function matchedBrands(caption, tags, brands) {
  const handles = new Set([...[...caption.matchAll(/(?:^|[^\w])@([A-Za-z0-9._]+)/g)].map(match => match[1].toLowerCase()), ...tags.map(tag => tag.toLowerCase())]);
  return brands.filter(brand => brand.handles.some(handle => handles.has(handle.toLowerCase())) || [brand.name, ...brand.aliases].some(alias => {
    const escaped = alias.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w@])${escaped}(?!\\w)`, "i").test(caption);
  }));
}

export function qualifyPost(data, person, brands, now = new Date()) {
  const identity = postIdentity(data.url);
  if (!identity || identity.type !== "p" || data.video) return { reason: "reel_or_video" };
  const header = (data.description || "").match(/^(?:[\d.,]+\s*[KMB]?\s+likes?,\s*[\d.,]+\s*[KMB]?\s+comments?\s*-\s*)?([A-Za-z0-9._]+)\s+on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}(?::\s*([\s\S]*)|$)/i);
  if (!header || header[1].toLowerCase() !== person.handle.toLowerCase()) return { reason: "author_or_caption_unverified" };
  const dates = [...new Set(data.dates.filter(item => {
    const target = postIdentity(item.permalink);
    return target?.shortcode === identity.shortcode && target.type === "p";
  }).map(item => item.datetime))];
  if (dates.length !== 1) return { reason: "date_unverified" };
  if (!recentPost(dates[0], now)) return { reason: "outside_today_yesterday" };
  const caption = (header[2] || "").replace(/^"|"\.?\s*$/g, "").trim();
  if (!matchedBrands(caption, data.tags || [], brands).length) return { reason: "no_recognized_brand" };
  if (!data.imageReady) return { reason: "post_photo_unverified" };
  return { metadata: { handle: person.handle, shortcode: identity.shortcode, published_at: dates[0], caption: caption.slice(0, 5000), tagged_handles: data.tags || [], media_type: "IMAGE", date_evidence: "post_permalink_time" } };
}

export function readPostDocument() {
  const root = document.querySelector("main") || document.querySelector("article");
  const description = document.querySelector('meta[property="og:description"]')?.getAttribute("content") || "";
  const cover = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
  const file = value => { try { return new URL(value).pathname.split("/").pop(); } catch { return null; } };
  const images = [...(root?.querySelectorAll("img") || [])];
  const photo = cover && images.find(image => image.complete && image.naturalWidth >= 320 && image.naturalHeight >= 320 && file(image.currentSrc || image.src) === file(cover));
  document.querySelectorAll("[data-hhc-post-photo]").forEach(element => element.removeAttribute("data-hhc-post-photo"));
  if (photo) photo.setAttribute("data-hhc-post-photo", "true");
  return {
    url: location.href, description,
    dates: [...(root?.querySelectorAll("time[datetime]") || [])].map(element => ({ datetime: element.getAttribute("datetime"), permalink: element.closest("a")?.href || "" })),
    video: !!document.querySelector('meta[property="og:video"], meta[property="og:video:secure_url"]') || !!root?.querySelector("video"),
    imageReady: !!photo,
    tags: [],
  };
}
