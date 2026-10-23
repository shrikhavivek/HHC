import { test } from "node:test";
import assert from "node:assert/strict";
import { galleryFromListing, postId } from "./reddit-gallery-rules.mjs";

const gallery = () => [{data:{children:[{kind:"t3",data:{id:"abc",is_gallery:true,gallery_data:{items:[{media_id:"two"},{media_id:"one"}]},media_metadata:{one:{status:"valid",e:"Image",s:{u:"https://preview.redd.it/one.jpg?width=1080&amp;format=pjpg"}},two:{status:"valid",e:"Image",s:{u:"https://i.redd.it/two.png"}}}}}]}}];
test("gallery order comes from the post, not metadata key order", () => {
  assert.deepEqual(galleryFromListing(gallery(), "abc"), ["https://i.redd.it/two.png", "https://i.redd.it/one.jpg"]);
});
test("missing slides and unrelated post responses are rejected", () => {
  const data=gallery(); delete data[0].data.children[0].data.media_metadata.one;
  assert.throws(() => galleryFromListing(data,"abc"), /unavailable/);
  assert.throws(() => galleryFromListing(gallery(),"other"), /requested post/);
});
test("only exact Reddit posts and image hosts are accepted", () => {
  assert.equal(postId("https://www.reddit.com/r/Fashion/comments/abc/title/"), "abc");
  assert.throws(() => postId("https://reddit.com.evil.test/r/Fashion/comments/abc/"));
  const data=gallery(); data[0].data.children[0].data.media_metadata.one.s.u="https://localhost/private.jpg";
  assert.throws(() => galleryFromListing(data,"abc"), /original photo/);
});
