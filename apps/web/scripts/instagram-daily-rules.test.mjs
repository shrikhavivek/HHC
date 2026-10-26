import test from "node:test";
import assert from "node:assert/strict";
import { postIdentity, recentPost, matchedBrands, qualifyPost } from "./instagram-daily-rules.mjs";

const now = new Date("2026-10-13T08:00:00Z");
const person = { name: "Kriti Sanon", handle: "kritisanon" };
const brands = [{ name: "Gucci", handles: ["gucci"], aliases: [] }];
const post = { url: "https://www.instagram.com/p/abc/", description: '10K likes, 5 comments - kritisanon on October 12, 2026: "Wearing @gucci".', dates: [{ datetime: "2026-10-12T12:00:00Z", permalink: "https://www.instagram.com/kritisanon/p/abc/" }], video: false, imageReady: true, tags: [] };

test("two local calendar days, not a rolling 48 hours or a week", () => {
  assert.equal(recentPost("2026-10-11T18:30:00Z", now), true);
  assert.equal(recentPost("2026-10-11T18:29:59Z", now), false);
  assert.equal(recentPost("2026-10-13T08:00:01Z", now), false);
  assert.equal(recentPost("2026-10-12T12:00:00", now), false);
});
test("recognize brand boundaries, not arbitrary people or similar handles", () => {
  assert.equal(matchedBrands("Outfit @Gucci", [], brands).length, 1);
  assert.equal(matchedBrands("A Gucci look", [], brands).length, 1);
  assert.equal(matchedBrands("@guccifan @stylist", [], brands).length, 0);
  assert.equal(matchedBrands("A look", ["gucci"], brands).length, 1);
});
test("canonical post identity rejects comments and non-Instagram sources", () => {
  assert.equal(postIdentity("https://www.instagram.com/kritisanon/p/abc/").shortcode, "abc");
  assert.equal(postIdentity("https://www.instagram.com/p/abc/c/123/"), null);
  assert.equal(postIdentity("https://instagram.com.example/p/abc/"), null);
});
test("only source-owned, dated photos with brand evidence qualify", () => {
  assert.equal(qualifyPost(post, person, brands, now).metadata.shortcode, "abc");
  assert.equal(qualifyPost({ ...post, video: true }, person, brands, now).reason, "reel_or_video");
  assert.equal(qualifyPost({ ...post, url: "https://www.instagram.com/reel/abc/" }, person, brands, now).reason, "reel_or_video");
  assert.equal(qualifyPost({ ...post, imageReady: false }, person, brands, now).reason, "post_photo_unverified");
  assert.equal(qualifyPost({ ...post, description: post.description.replace("kritisanon", "fanpage") }, person, brands, now).reason, "author_or_caption_unverified");
  assert.equal(qualifyPost({ ...post, description: post.description.replace("@gucci", "@stylist") }, person, brands, now).reason, "no_recognized_brand");
});
test("comments and suggested-post dates never qualify", () => {
  for (const permalink of ["https://www.instagram.com/p/abc/c/123/", "https://www.instagram.com/p/other/"]) {
    assert.equal(qualifyPost({ ...post, dates: [{ ...post.dates[0], permalink }] }, person, brands, now).reason, "date_unverified");
  }
  assert.equal(qualifyPost({ ...post, dates: [...post.dates, { ...post.dates[0], datetime: "2026-10-13T01:00:00Z" }] }, person, brands, now).reason, "date_unverified");
});

test("explicit clothing credits can identify a new label without accepting unrelated tags", () => {
  assert.equal(matchedBrands("Outfit: @newfashionlabel", [], brands)[0].name, "@newfashionlabel");
  assert.equal(matchedBrands("Wearing @newfashionlabel", [], brands).length, 1);
  assert.equal(matchedBrands("Photos: @newfashionlabel", [], brands).length, 0);
  assert.equal(matchedBrands("With @friend", [], brands).length, 0);
  assert.equal(matchedBrands("Wearing @stylist", [], brands).length, 0);
});
