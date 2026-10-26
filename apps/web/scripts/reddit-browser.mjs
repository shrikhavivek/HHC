import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { request } from "./browser-local-api.mjs";
import { waitForRedditLogin, redditSessionState } from "./reddit-login.mjs";
import { captureRedditCarousel } from "./reddit-carousel.mjs";
import { postId } from "./reddit-gallery-rules.mjs";
import { navigateReddit, keepRedditWindowOpen } from "./reddit-browser-window.mjs";
import { redditPublication } from "./reddit-publication.mjs";
import { collectionWindow, dateInWindow, scanWindow } from "./scan-window.mjs";

const api = (path, body) => request("reddit", path, body);
const claimed = (await api("/claim", {})).run;
if (!claimed) process.exit(0);
const summary = { run_id: claimed.run_id, status: "running", posts_checked: 0, imported: 0, exclusions: {}, detail: "Opening Reddit." };
const report = () => api("/runs", summary);
const exclude = reason => { summary.exclusions[reason] = (summary.exclusions[reason] || 0) + 1; };
let context;
let reporting = false;
let heartbeatError;
const timer = setInterval(async () => {
  if (reporting) return;
  reporting = true;
  try { await report(); } catch (error) { heartbeatError = error; } finally { reporting = false; }
}, 10000);
try {
  const config = await api("/config");
  const window = collectionWindow(new Date(), config.timezone);
  summary.coverage = { ...window, targets: [{ target: `r/${config.subreddit}`, status: "not_started" }] };
  const known = new Map((await api("/known")).flatMap(post => { try { return [[postId(post.permalink), post]]; } catch { return []; } }));
  if (!/^[A-Za-z0-9_]{1,50}$/.test(config.subreddit)) throw new Error("Configure a valid subreddit.");
  const profile = join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "HHC", "reddit-browser-profile");
  await mkdir(profile, { recursive: true });
  context = await chromium.launchPersistentContext(profile, { channel: "msedge", headless: false, acceptDownloads: false, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const page = context.pages()[0] || await context.newPage();
  const navigate = async (url, ready, resumedStatus, resumedDetail, targetPage = page) => navigateReddit(targetPage, url, {
    ready,
    onWaiting: async () => {
      summary.status = "awaiting_attention";
      summary.detail = "Reddit could not load this page. The window is still open. Refresh it or complete Reddit's sign-in/verification there; collection continues when the requested page loads.";
      await report();
    },
    onResumed: async () => { summary.status = resumedStatus; summary.detail = resumedDetail; await report(); },
  });
  summary.status = "awaiting_login";
  summary.detail = "Sign in or complete verification in the Reddit window. Collection continues automatically after sign-in. Keep the window open.";
  await report();
  await navigate("https://www.reddit.com/login/?dest=https%3A%2F%2Fwww.reddit.com%2F",
    async () => await redditSessionState(page) === "signed_in", "awaiting_login", "Complete sign-in in the Reddit window. Collection continues automatically.");
  await page.bringToFront();
  await waitForRedditLogin(page);
  if (heartbeatError) throw heartbeatError;
  summary.status = "running";
  summary.detail = `Reading recent photo posts in r/${config.subreddit}.`;
  await report();
  const listing = await context.newPage();
  await navigate(`https://www.reddit.com/r/${config.subreddit}/new/`,
    async () => new URL(listing.url()).pathname.toLowerCase() === `/r/${config.subreddit.toLowerCase()}/new/` && await redditSessionState(listing) !== "blocked" && await listing.locator("shreddit-post").count() > 0,
    "running", `Reading recent photo posts in r/${config.subreddit}.`, listing);
  const accessCheck = async (targetPage = page) => {
    if (heartbeatError) throw heartbeatError;
    const state = await redditSessionState(targetPage);
    if (state === "blocked") throw new Error("Reddit restricted access. Collection stopped; complete any checks in Reddit before trying again.");
    if (state === "waiting" && /\/(login|challenge|captcha)(\/|$)/.test(new URL(targetPage.url()).pathname)) throw new Error("Reddit requires sign-in again. Choose Sign in to Reddit and collect photos to resume.");
  };
  await listing.waitForTimeout(2500);
  const coverage = await scanWindow({
    target: `r/${config.subreddit}`, window, oldBoundary: 6,
    readBatch: async () => {
      const posts = await listing.locator("shreddit-post").evaluateAll(items => items.map(post => ({
        url: post.getAttribute("permalink"), published_at: post.getAttribute("created-timestamp"),
        pinned: post.hasAttribute("stickied") && post.getAttribute("stickied") !== "false" || !!post.querySelector('[aria-label*="pinned" i], [aria-label*="stickied" i]'),
      })));
      return posts.flatMap(post => {
        try {
          const url = new URL(post.url, "https://www.reddit.com");
          if (url.hostname !== "www.reddit.com" || !url.pathname.toLowerCase().startsWith(`/r/${config.subreddit.toLowerCase()}/comments/`)) return [];
          return [{ ...post, id: postId(url.href), url: `${url.origin}${url.pathname.split('/').slice(0, 6).join('/')}/` }];
        } catch { return []; }
      });
    },
    advance: async () => { await listing.bringToFront(); await listing.mouse.wheel(0, 900); await listing.waitForTimeout(2500); },
    check: () => accessCheck(listing),
    onProgress: async value => { summary.coverage.targets[0] = value; await report(); },
    onVisitError: async () => { await accessCheck(); exclude("post_capture_failed"); return { outcome: "failed" }; },
    visit: async entry => {
    const { id, url: link } = entry;
    // Dates observed on the chronological /new listing avoid opening old posts.
    if (dateInWindow(entry.published_at, window) === "older") {
      summary.posts_checked++; exclude("outside_today_yesterday");
      return { published_at: entry.published_at, outcome: "excluded" };
    }
    await accessCheck();
    await report();
    await navigate(link, async () => {
      try { return postId(page.url()) === id && await redditSessionState(page) !== "blocked" && await page.locator(`shreddit-post[id="t3_${id}"]`).count() > 0; }
      catch { return false; }
    }, "running", "Reddit is available again. Continuing photo collection.");
    await accessCheck();
    await page.locator(`shreddit-post[id="t3_${id}"]`).waitFor({ timeout: 15000 });
    if (postId(page.url()) !== id) throw new Error("Reddit redirected away from the requested post.");
    const metadata = await page.locator(`shreddit-post[id="t3_${id}"]`).evaluate(post => {
      const title = post.getAttribute("post-title") || post.querySelector('h1,[slot="title"]')?.textContent?.trim() || "";
      const published = post.getAttribute("created-timestamp") || post.querySelector("time[datetime]")?.getAttribute("datetime");
      return { title, published_at: published, author: post.getAttribute("author") || "unknown", description: (post.querySelector('[slot="text-body"]')?.textContent || "").trim().slice(0, 10000) };
    });
    summary.posts_checked++;
    if (!metadata.title) { exclude("title_unverified"); return { published_at: metadata.published_at, outcome: "failed" }; }
    const publication = redditPublication(metadata.published_at, config.timezone, new Date(window.as_of));
    if (publication.reason) { exclude(publication.reason); return { published_at: metadata.published_at, outcome: publication.reason === "date_unverified" ? "failed" : "excluded" }; }
    metadata.published_at = publication.published_at;
    if (known.get(id)?.complete) { exclude("already_imported"); return { published_at: metadata.published_at, qualifying: true, outcome: "existing" }; }
    try {
      const capture = await captureRedditCarousel(page, { accessCheck });
      if (!capture.complete || !capture.photos.length) { exclude("incomplete_carousel"); return { published_at: metadata.published_at, qualifying: true, outcome: "failed" }; }
      const form = new FormData();
      form.set("metadata", JSON.stringify({ ...metadata, post_id: id, permalink: link, images: capture.photos.map(photo => photo.url), carousel_complete: true, expected_revision: known.get(id)?.revision }));
      capture.photos.forEach((photo, i) => form.append("images", new Blob([photo.bytes], { type: "image/jpeg" }), `photo-${i + 1}.jpg`));
      const result = await api("/posts", form);
      if (result.excluded) exclude(result.excluded);
      else if (result.duplicate) exclude("already_imported");
      else summary.imported++;
      await report();
      await page.waitForTimeout(2000);
      return { published_at: metadata.published_at, qualifying: !result.excluded, outcome: result.excluded ? "excluded" : result.duplicate ? "existing" : "collected" };
    } catch (error) {
      await accessCheck();
      // An inaccessible or non-photo post must not prevent later photo posts.
      const video = /video/i.test(error.message);
      exclude(video ? "reel_or_video" : "post_capture_failed");
      return { published_at: metadata.published_at, outcome: video ? "excluded" : "failed" };
    }
  }});
  summary.status = coverage.status === "complete" ? "completed" : "partial";
  summary.detail = summary.imported
    ? `${summary.imported} posts collected and available on the editorial desk. Review the captured photos and attribution before publishing.`
    : "No new posts were collected. Check the exclusion counts below for the reason.";
  summary.detail += coverage.status === "complete" ? " Scanned through yesterday's date boundary." : ` Coverage is incomplete (${coverage.stop_reason.replaceAll("_", " ")}); scan again to cover the remaining posts.`;
} catch (error) {
  const closed = context?.pages().length === 0;
  const detail = error.message.split("\n")[0].replace(/\u001b\[[0-9;]*m/g, "").slice(0, 650);
  summary.status = closed ? "cancelled" : "failed";
  summary.detail = closed ? "The Reddit window was closed. Choose Sign in to Reddit & collect photos to start again." : detail;
  if (context?.pages().some(page => !page.isClosed())) {
    await keepRedditWindowOpen(context, async () => {
      summary.status = "awaiting_attention";
      summary.detail = `${detail} Collection is paused. The Reddit window stays open for you to review. Close it, then start a new collection to retry.`;
      await report().catch(() => {});
    });
    summary.status = "cancelled";
    summary.detail = `Collection stopped: ${detail} The Reddit window was closed; you can start again when ready.`;
  }
} finally {
  clearInterval(timer);
  // Finish any heartbeat before publishing the terminal status.
  while (reporting) await new Promise(resolve => setTimeout(resolve, 20));
  await report().catch(() => {});
  await context?.close().catch(() => {});
}
