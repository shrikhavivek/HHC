import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { postIdentity, readPostDocument } from "./instagram-daily-rules.mjs";
import { hashtagLead } from "./instagram-hashtag-rules.mjs";

class AccessBlocked extends Error {}

async function accessCheck(page, response) {
  if ([401, 403, 429].includes(response?.status()) || /\/(accounts|challenge|checkpoint)\//.test(new URL(page.url()).pathname)
      || await page.locator('input[type="password"], form[action*="challenge"], form[action*="captcha"]').count()
      || await page.getByText(/try again later|we restrict certain activity|automated behavior|confirm you're human|unusual activity/i).count()) {
    throw new AccessBlocked("Instagram requires sign-in, verification, or has restricted access. Open the local Instagram browser yourself before searching again.");
  }
}

export async function runHashtagSearch(job, { request }) {
  const summary = { run_id: job.run_id, status: "running", tags_checked: 0, posts_checked: 0, results: [], exclusions: {}, detail: "Searching designer and outfit hashtags." };
  const report = () => request("/hashtag-search/runs", summary);
  const exclude = reason => { summary.exclusions[reason] = (summary.exclusions[reason] || 0) + 1; };
  let context;
  let incomplete = false;
  try {
    await report();
    const profile = join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "HHC", "instagram-browser-profile");
    await mkdir(profile, { recursive: true });
    context = await chromium.launchPersistentContext(profile, { channel: "msedge", headless: false, viewport: { width: 1440, height: 1100 }, acceptDownloads: false });
    const page = context.pages()[0] || await context.newPage();
    const seen = new Set();
    for (const tag of job.hashtags.slice(0, 6)) {
      if (!(await request("/config")).enabled) { summary.status = "paused"; break; }
      summary.detail = `Searching #${tag}; keeping only posts with every selected hashtag.`;
      await report();
      const response = await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await delay(2500);
      await accessCheck(page, response);
      const links = new Set();
      for (let batch = 0; batch < 2; batch += 1) {
        const found = await page.locator('main a[href*="/p/"]').evaluateAll(anchors => anchors.filter(anchor => anchor.getClientRects().length).map(anchor => anchor.href));
        for (const link of found) {
          const identity = postIdentity(link);
          if (identity?.type === "p") links.add(`https://www.instagram.com/p/${identity.shortcode}/`);
        }
        if (links.size >= 8 || batch === 1) break;
        await page.mouse.wheel(0, 900);
        await delay(2000);
        await accessCheck(page);
      }
      summary.tags_checked += 1;
      if (!links.size) { exclude("hashtag_no_readable_photo_links"); incomplete = true; }
      for (const link of [...links].slice(0, 8)) {
        if (seen.has(link)) continue;
        seen.add(link);
        await report();
        await delay(5000);
        const postResponse = await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45000 });
        await delay(2000);
        await accessCheck(page, postResponse);
        summary.posts_checked += 1;
        const data = await page.evaluate(readPostDocument);
        if (postIdentity(data.url)?.shortcode !== postIdentity(link)?.shortcode) { exclude("redirected_post"); incomplete = true; continue; }
        const result = hashtagLead(data, tag, job.excluded_terms, new Date(), job.hashtags);
        if (result.reason) { exclude(result.reason); if (/unverified/.test(result.reason)) incomplete = true; continue; }
        summary.results.push(result.lead);
        if (summary.results.length >= 24) break;
      }
      if (summary.results.length >= 24) { incomplete = true; exclude("result_limit_reached"); break; }
      await delay(5000);
    }
    if (summary.status !== "paused") summary.status = incomplete ? "partial" : "completed";
    summary.detail = "Only posts containing every selected hashtag in their caption are shown. Compare photos and confirm attribution and rights before adding a source.";
  } catch (error) {
    summary.status = error instanceof AccessBlocked ? "blocked" : "failed";
    summary.detail = error instanceof AccessBlocked ? error.message : "Hashtag search could not complete. Check the local collector and close any other HHC Instagram browser before retrying.";
  } finally {
    if (context) await context.close();
    await report();
  }
  return summary;
}
