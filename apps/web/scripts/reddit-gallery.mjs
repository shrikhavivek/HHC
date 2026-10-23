import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { postId } from "./reddit-gallery-rules.mjs";
import { captureRedditCarousel } from "./reddit-carousel.mjs";
import { redditSessionState, waitForRedditLogin } from "./reddit-login.mjs";
import { apiRootFrom, stagePhotos } from "./staged-photos.mjs";

const envFile = process.env.HHC_ENV_FILE || fileURLToPath(new URL("../../../.env", import.meta.url));
const environment = parseEnv(await readFile(envFile, "utf8"));
const key = process.env.EDITOR_API_KEY || environment.EDITOR_API_KEY || ((process.env.APP_ENV || environment.APP_ENV) === "production" ? "" : "local-editor-key");
if (!key) throw new Error("Configure EDITOR_API_KEY in the local environment file");
const apiRoot = apiRootFrom(environment);
const headers = {"X-Editor-Key": key, "X-Editor-Id": "local-reddit-browser"};
async function api(path, body) {
  const form = body instanceof FormData;
  if (form) body = await stagePhotos(body, apiRoot, headers);
  const response = await fetch(`${apiRoot}/api/reddit-gallery${path}`, {
    method: body ? "POST" : "GET", redirect: "error",
    headers: {...headers, ...(!form ? {"Content-Type": "application/json"} : {})},
    body: body ? form ? body : JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Local import failed (${response.status})`);
  return data;
}

const pending = await api("/pending");
const posts = process.argv.includes("--one") ? pending.slice(0, 1) : pending;
if (!posts.length) {
  console.log("No incomplete Reddit galleries in today's or yesterday's feed.");
  process.exit(0);
}
const profile = join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "HHC", "reddit-browser-profile");
await mkdir(profile, {recursive:true});
const browser = await chromium.launchPersistentContext(profile, {channel:"msedge", headless:false, acceptDownloads:false, viewport:{width:1440,height:1000}, deviceScaleFactor:2});
let imported = 0;
try {
  const page = browser.pages()[0] || await browser.newPage();
  if (!process.argv.includes("--confirmed-login")) {
    await page.goto("https://www.reddit.com/login/?dest=https%3A%2F%2Fwww.reddit.com%2F", {waitUntil:"domcontentloaded", timeout:45000});
    console.log("Sign in directly to Reddit in the Edge window. Your password stays in Reddit; the collector waits for a signed-in page before opening a post.");
    await waitForRedditLogin(page);
  }
  console.log("Using the local Reddit session. Testing the first post's carousel.");
  for (const post of posts) {
    const id = postId(post.permalink);
    await page.goto(post.permalink, {waitUntil:"domcontentloaded", timeout:45000});
    if (await redditSessionState(page) === "blocked") throw new Error("Reddit still blocks this post after sign-in; no further posts will be requested");
    const root = page.locator(`shreddit-post[id="t3_${id}"]`);
    if (!await root.count()) console.log("Complete Reddit verification or sign in in the browser. Waiting up to ten minutes; no challenge is solved automatically.");
    await root.waitFor({state:"attached", timeout:600000});
    if (postId(page.url()) !== id) throw new Error("Return to the requested post before recovering its photos");
    const capture = await captureRedditCarousel(page, {onPhoto:(count,total)=>console.log(`Captured photo ${count}${total ? `/${total}` : ''}`), accessCheck: async () => {
      if (await redditSessionState(page) === "blocked") throw new Error("Reddit restricted access during capture; the existing collage was preserved");
    }});
    const form = new FormData();
    form.set("metadata", JSON.stringify({post_id:id, images:capture.photos.map(photo=>photo.url), expected_revision:post.revision, carousel_complete:capture.complete}));
    capture.photos.forEach((photo,index) => form.append("images", new Blob([photo.bytes], {type:"image/jpeg"}), `photo-${index+1}.jpg`));
    const result = await api(`/cases/${post.id}/screenshots`, form);
    imported++;
    console.log(`${imported}/${posts.length}: ${post.title} — ${result.images} photos recovered`);
    await page.waitForTimeout(2000);
  }
} catch (error) {
  console.error(`Recovery stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`${imported}/${posts.length} posts recovered. Refresh the studio to see updated collages.`);
}
