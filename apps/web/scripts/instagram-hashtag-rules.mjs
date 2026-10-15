import { postIdentity } from "./instagram-daily-rules.mjs";

export function mentionsSourceCelebrity(value, excludedTerms, compound = false) {
  const normalized = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  const compact = text => text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = new Set((value.match(/[\w.-]+/g) || []).map(compact));
  const compounds = compound ? [normalized] : [...value.matchAll(/[#@]([\w.-]+)/g)].map(match => compact(match[1]));
  return excludedTerms.some(term => words.has(term) || term.length >= 6 && normalized.includes(term)
    || compounds.some(word => word.startsWith(term) || word.endsWith(term)));
}

export function containsAllHashtags(caption, required) {
  const text = caption.normalize("NFKC").replace(/https?:\/\/\S+/g, "");
  const observed = new Set([...text.matchAll(/(?<![\p{L}\p{N}_#])#([\p{L}\p{N}_]+)/gu)].map(match => match[1].toLowerCase()));
  return required.length > 0 && required.every(tag => observed.has(tag.toLowerCase()));
}

export function hashtagLead(data, hashtag, excludedTerms, now = new Date(), requiredHashtags = [hashtag]) {
  const identity = postIdentity(data.url);
  if (!identity || identity.type !== "p" || data.video) return { reason: "reel_or_video" };
  if (!data.imageReady) return { reason: "post_photo_unverified" };
  const header = (data.description || "").match(/^(?:[\d.,]+\s*[KMB]?\s+likes?,\s*[\d.,]+\s*[KMB]?\s+comments?\s*-\s*)?([A-Za-z0-9._]+)\s+on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}(?::\s*([\s\S]*)|$)/i);
  if (!header || identity.owner && identity.owner !== header[1].toLowerCase()) return { reason: "author_or_caption_unverified" };
  const caption = (header[2] || "").replace(/^"|"\.?\s*$/g, "").trim().slice(0, 5000);
  if (mentionsSourceCelebrity(header[1], excludedTerms, true) || mentionsSourceCelebrity(caption, excludedTerms)) return { reason: "source_celebrity" };
  if (!containsAllHashtags(caption, requiredHashtags)) return { reason: "missing_required_hashtags" };
  const dates = [...new Set((data.dates || []).filter(item => {
    const target = postIdentity(item.permalink);
    return target?.shortcode === identity.shortcode && target.type === "p";
  }).map(item => item.datetime))];
  const value = dates.length === 1 ? dates[0] : null;
  const dated = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value || "") && Number.isFinite(new Date(value).getTime()) && new Date(value) <= now;
  return { lead: { shortcode: identity.shortcode, hashtag, author: header[1], caption: caption.slice(0, 5000), published_at: dated ? value : null } };
}
