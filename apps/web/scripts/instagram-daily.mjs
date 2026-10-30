import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { postIdentity, postPublication, qualifyPost, readPostDocument } from "./instagram-daily-rules.mjs";
import { collectionWindow, dateInWindow, scanWindow } from "./scan-window.mjs";
import { captureCarousel } from "./instagram-carousel.mjs";
import { waitForInstagramLogin, InstagramAccessBlocked, InstagramLoginCancelled, InstagramIntakePaused } from "./instagram-login.mjs";
import { request } from "./instagram-local-api.mjs";

const dryRun = process.argv.includes("--dry-run");
const limitIndex = process.argv.indexOf("--limit");
const limit = limitIndex < 0 ? 200 : Number(process.argv[limitIndex + 1]);
if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Account limit must be 1–200.");
const handleIndex = process.argv.indexOf("--handle");
const selectedHandle = handleIndex < 0 ? null : process.argv[handleIndex + 1]?.toLowerCase();
if (handleIndex >= 0 && !/^[a-z0-9._]{1,30}$/.test(selectedHandle || "")) throw new Error("Supply a valid watched handle.");

class AccessBlocked extends InstagramAccessBlocked {}
async function accessCheck(page) {
  if (/\/(accounts|challenge|checkpoint)\//.test(new URL(page.url()).pathname) || await page.locator('input[type="password"], form[action*="challenge"], form[action*="captcha"]').count() || await page.getByText(/try again later|we restrict certain activity|automated behavior|confirm you're human|unusual activity/i).count()) {
    throw new AccessBlocked("Instagram requires sign-in, verification, or has restricted access. Open the local trial browser yourself; no automatic retry was attempted.");
  }
}

const queued = process.argv.includes("--queued");
const claimed = queued ? (await request("/claim", {})).run : null;
if (queued && !claimed) process.exit(0);
const config = await request("/config");
if (config.timezone !== "Asia/Kolkata") throw new Error("This local collector currently requires Asia/Kolkata.");
const summary = { run_id: claimed?.run_id || randomUUID(), status: "running", accounts_checked: 0, posts_checked: 0, imported: 0, updated: 0, detail: "Collecting photo posts and carousel slides from the signed-in Instagram browser.", exclusions: {}, current_account: "", accounts_total: 0, dry_run: dryRun };
const window = collectionWindow(new Date(), config.timezone);
summary.coverage = { ...window, targets: config.celebrities.filter(person => person.enabled).map(person => ({ target: person.handle, status: "not_started" })) };
const known = new Set((await request("/posts")).results.filter(post => post.carousel_complete).map(post => postIdentity(post.permalink)?.shortcode).filter(Boolean));
const exclude = reason => { summary.exclusions[reason] = (summary.exclusions[reason] || 0) + 1; };
if (!config.enabled) {
  await request("/runs", { ...summary, status: "paused", detail: "Daily browser intake is paused in the dashboard." });
  process.exit(0);
}
await request("/runs", summary);
let context;
let incomplete = false;
try {
  const profile = join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "HHC", "instagram-browser-profile");
  await mkdir(profile, { recursive: true });
  context = await chromium.launchPersistentContext(profile, { channel: "msedge", headless: false, viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: false });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(15000);
  const listing = await context.newPage();
  const people = config.celebrities.filter(person => person.enabled && (!selectedHandle || person.handle.toLowerCase() === selectedHandle)).slice(0, limit);
  summary.accounts_total = people.length;
  if (selectedHandle && !people.length) throw new Error("Requested handle is not enabled in the watchlist.");
  summary.status = "awaiting_login";
  summary.detail = "Sign in or complete verification in the Instagram window. The scan starts automatically once you are signed in. Keep that window open.";
  await request("/runs", summary);
  const loginResponse = await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  if ([403, 429].includes(loginResponse?.status())) throw new AccessBlocked("Instagram denied access. Resolve the restriction in Instagram before starting another scan.");
  await page.bringToFront();
  await waitForInstagramLogin(page, {
    onWaiting: () => request("/runs", summary),
    isEnabled: async () => (await request("/config")).enabled,
  });
  summary.status = "running";
  summary.detail = "Signed in. Scanning each watched account through yesterday and collecting photos with brand or designer credits.";
  await request("/runs", summary);
  for (const person of people) {
    if (page.isClosed()) throw new InstagramLoginCancelled("Instagram was closed. Choose Scan now to start a new scan.");
    if (!(await request("/config")).enabled) {
      summary.status = "paused";
      break;
    }
    summary.current_account = person.name;
    await request("/runs", summary);
    console.log(`Checking ${person.name} (@${person.handle})`);
    try {
      const response = await listing.goto(`https://www.instagram.com/${person.handle}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      if ([401, 403, 429].includes(response?.status())) throw new AccessBlocked("Instagram denied access. Daily scan stopped; no retry attempted.");
      await delay(2500);
      await accessCheck(listing);
      const coverage = await scanWindow({
        target: person.handle, window,
        readBatch: async () => {
          const anchors = await listing.locator('main a[href*="/p/"], main a[href*="/reel/"]').evaluateAll(items => items.map(anchor => ({ url: anchor.href, pinned: !!anchor.querySelector('[aria-label*="Pinned" i], [aria-label*="pin post" i]') })));
          return anchors.flatMap(anchor => {
            const identity = postIdentity(anchor.url);
            if (!identity || identity.type !== "p" || identity.owner && identity.owner !== person.handle.toLowerCase()) return [];
            return [{ id: identity.shortcode, url: `https://www.instagram.com/${identity.type}/${identity.shortcode}/`, pinned: anchor.pinned }];
          });
        },
        advance: async () => { await listing.bringToFront(); await listing.mouse.wheel(0, 900); await delay(2500); },
        check: async () => {
          if (!(await request("/config")).enabled) throw new InstagramIntakePaused("Instagram scanning was paused.");
          await accessCheck(listing);
        },
        onProgress: async value => {
          const index = summary.coverage.targets.findIndex(item => item.target === person.handle);
          summary.coverage.targets[index] = value;
          await request("/runs", summary);
        },
        onVisitError: async error => {
          if (page.isClosed()) throw new InstagramLoginCancelled("Instagram was closed. Start a new scan to continue.");
          if (error instanceof InstagramAccessBlocked || String(error.message).startsWith("Local API")) throw error;
          await accessCheck(page);
          exclude("post_capture_failed");
          return { outcome: "failed" };
        },
        visit: async entry => {
        const link = entry.url;
        await request("/runs", summary);
        await delay(5000);
        const postResponse = await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45000 });
        if ([401, 403, 429].includes(postResponse?.status())) throw new AccessBlocked("Instagram denied post access. Daily scan stopped.");
        await delay(2000);
        await accessCheck(page);
        summary.posts_checked += 1;
        const data = await page.evaluate(readPostDocument);
        const expected = postIdentity(link);
        if (postIdentity(data.url)?.shortcode !== expected.shortcode) { exclude("redirected_post"); return { outcome: "failed" }; }
        const published_at = postPublication(data);
        const date = dateInWindow(published_at, window);
        if (date !== "recent") { exclude(date === "older" ? "outside_today_yesterday" : date === "newer_than_scan" ? "newer_than_scan" : "date_unverified"); return { published_at, outcome: date === "unverified" ? "failed" : "excluded" }; }
        let result = qualifyPost(data, person, config.brands, new Date(window.as_of));
        if (result.reason === "no_recognized_brand" && data.imageReady && !data.video) {
          const photo = page.locator('[data-hhc-post-photo="true"]');
          const tagButton = page.getByRole("button", { name: /^(view tags|tagged people)$/i });
          if (await tagButton.count() === 1 && await tagButton.isVisible()) {
            const imageBounds = await photo.boundingBox();
            const buttonBounds = await tagButton.boundingBox();
            if (imageBounds && buttonBounds && buttonBounds.x >= imageBounds.x && buttonBounds.y >= imageBounds.y && buttonBounds.x <= imageBounds.x + imageBounds.width && buttonBounds.y <= imageBounds.y + imageBounds.height) {
              const tagControl = await tagButton.elementHandle();
              if (!tagControl) throw new Error("Photo tag control is unavailable.");
              await tagControl.click();
              await delay(500);
              await accessCheck(page);
              data.tags = await photo.evaluate(image => {
                const bounds = image.getBoundingClientRect();
                return [...new Set([...document.querySelectorAll('a[href]')].filter(anchor => {
                  const rect = anchor.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0 && rect.x >= bounds.x && rect.y >= bounds.y && rect.right <= bounds.right && rect.bottom <= bounds.bottom;
                }).map(anchor => {
                  const url = new URL(anchor.href);
                  return url.hostname === "www.instagram.com" ? url.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/$/)?.[1] : null;
                }).filter(Boolean))];
              });
              await tagControl.click();
            }
          }
        }
        result = qualifyPost(data, person, config.brands, new Date(window.as_of));
        if (result.reason) { exclude(result.reason); return { published_at, outcome: /unverified/.test(result.reason) ? "failed" : "excluded" }; }
        if (known.has(expected.shortcode)) { exclude("already_imported"); return { published_at, qualifying: true, outcome: "existing" }; }
        if (dryRun) { console.log(`Eligible: ${person.name} ${link} (${result.metadata.published_at})`); return { published_at, qualifying: true, outcome: "excluded" }; }
        const carousel = await captureCarousel(page, { accessCheck, heartbeat: () => request("/runs", summary) });
        if (!carousel.complete) { incomplete = true; exclude(carousel.reason || "carousel_incomplete"); }
        if (!carousel.photos.length) return { published_at, qualifying: true, outcome: "failed" };
        const form = new FormData();
        form.set("metadata", JSON.stringify({ ...result.metadata, image_keys: carousel.photos.map(photo => photo.key), carousel_complete: carousel.complete, videos_skipped: carousel.videosSkipped }));
        carousel.photos.forEach((photo, index) => form.append(index === 0 ? "image" : "images", new Blob([photo.bytes], { type: "image/jpeg" }), `instagram-photo-${index + 1}.jpg`));
        const imported = await request("/posts", form, true);
        if (imported.duplicate) exclude("already_imported"); else if (imported.updated) summary.updated += 1; else summary.imported += 1;
        console.log(`${imported.updated ? "Updated" : imported.duplicate ? "Already collected" : "Imported"}: ${person.name} — ${imported.photo_count || 1} photos (${carousel.complete ? "complete" : "partial"} carousel)`);
        return { published_at, qualifying: true, outcome: !carousel.complete ? "failed" : imported.duplicate ? "existing" : "collected" };
      }});
      summary.accounts_checked += 1;
      if (coverage.status !== "complete") incomplete = true;
      await delay(5000);
    } catch (error) {
      if (page.isClosed()) throw new InstagramLoginCancelled("Instagram was closed. Choose Scan now to start a new scan.");
      if (error instanceof AccessBlocked || String(error.message).startsWith("Local API")) throw error;
      console.error(`Account check failed for @${person.handle}: ${error.stack || error.message}`);
      exclude("account_check_failed");
      const index = summary.coverage.targets.findIndex(item => item.target === person.handle);
      summary.coverage.targets[index] = { ...summary.coverage.targets[index], status: "partial", stop_reason: "account_check_failed" };
      incomplete = true;
    }
  }
  if (summary.status !== "paused") summary.status = incomplete || people.length < config.celebrities.filter(person => person.enabled).length || dryRun ? "partial" : "completed";
  const covered = summary.coverage.targets.filter(item => item.status === "complete").length;
  summary.detail = `${dryRun ? "Read-only trial. " : ""}${covered} of ${summary.coverage.targets.length} watched accounts scanned through yesterday without gaps. ${summary.imported} posts collected; ${summary.updated} drafts expanded. Brand/designer credits required; reels and videos excluded. Check coverage details for unfinished accounts.`;
} catch (error) {
  summary.status = error instanceof InstagramAccessBlocked ? "blocked" : error instanceof InstagramLoginCancelled ? "cancelled" : error instanceof InstagramIntakePaused ? "paused" : "failed";
  summary.detail = error instanceof InstagramAccessBlocked || error instanceof InstagramLoginCancelled || error instanceof InstagramIntakePaused ? error.message : "Collector could not complete. Check that the local app is running and close any other HHC Instagram trial window before retrying.";
} finally {
  summary.current_account = "";
  if (context) await context.close();
  await request("/runs", summary);
  console.log(JSON.stringify(summary, null, 2));
}
if (["failed", "blocked"].includes(summary.status)) process.exitCode = 1;
