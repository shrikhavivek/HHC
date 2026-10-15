import test from "node:test";
import assert from "node:assert/strict";
import { hashtagLead, containsAllHashtags } from "./instagram-hashtag-rules.mjs";

const data = {
  url: "https://www.instagram.com/p/older/", video: false, imageReady: true,
  description: 'designerarchive on January 1, 2020: "Red silk saree on another wearer. #Sabyasachi #SilkSaree"',
  dates: [{ datetime: "2020-01-01T10:00:00Z", permalink: "https://www.instagram.com/p/older/" }],
};
const excluded = ["alia", "bhatt", "aliaabhatt"];

test("historical posts qualify as unverified leads without the daily-intake restriction", () => {
  const result = hashtagLead(data, "silksaree", excluded);
  assert.equal(result.lead.published_at, "2020-01-01T10:00:00Z");
  assert.equal(result.lead.hashtag, "silksaree");
});

test("celebrity author, names and concatenated hashtags are excluded", () => {
  for (const caption of ["Alia Bhatt in silk", "#AliaBhattStyle", "@aliaabhatt", "#BhattSaree"]) {
    assert.equal(hashtagLead({ ...data, description: `archive on January 1, 2020: "${caption}"` }, "silksaree", excluded).reason, "source_celebrity");
  }
  assert.equal(hashtagLead({ ...data, description: 'aliaabhatt on January 1, 2020: "Red silk saree"' }, "silksaree", excluded).reason, "source_celebrity");
});

test("short celebrity names do not match unrelated fabric descriptions", () => {
  assert.ok(hashtagLead({ ...data, description: 'archive on January 1, 2020: "Italian silk saree #italiansilk"' }, "italiansilk", excluded).lead);
});

test("every required hashtag must appear in the same caption", () => {
  const required = ["sabyasachi", "silksaree"];
  assert.ok(hashtagLead(data, "silksaree", excluded, new Date(), required).lead);
  for (const caption of ["#sabyasachi", "#silksaree", "Sabyasachi silk saree", "#sabyasachi #silksareeExtra", "#sabyasachi #silksareeé", "#sabyasachi ##silksaree", "#sabyasachi https://example.com/#silksaree"]) {
    assert.equal(containsAllHashtags(caption, required), false, caption);
    assert.equal(hashtagLead({ ...data, description: `archive on January 1, 2020: "${caption}"` }, "sabyasachi", excluded, new Date(), required).reason, "missing_required_hashtags");
  }
});

test("comment dates and future dates do not become claimed post dates", () => {
  for (const dates of [[], [{ datetime: "2020-01-01T10:00:00Z", permalink: "https://www.instagram.com/p/comment/" }],
    [{ datetime: "2099-01-01T10:00:00Z", permalink: data.url }]]) {
    assert.equal(hashtagLead({ ...data, dates }, "silksaree", excluded).lead.published_at, null);
  }
});

test("video, unreadable photo and unverified owner are not photo leads", () => {
  assert.equal(hashtagLead({ ...data, video: true }, "silksaree", excluded).reason, "reel_or_video");
  assert.equal(hashtagLead({ ...data, imageReady: false }, "silksaree", excluded).reason, "post_photo_unverified");
  assert.equal(hashtagLead({ ...data, url: "https://www.instagram.com/someoneelse/p/older/" }, "silksaree", excluded).reason, "author_or_caption_unverified");
});
