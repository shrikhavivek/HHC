import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { postIdentity } from "./instagram-daily-rules.mjs";

export function readCarouselSlide(initialize = false) {
  const bounds = element => element.getBoundingClientRect();
  const visible = element => {
    const rectangle = bounds(element);
    const style = getComputedStyle(element);
    return rectangle.width > 0 && rectangle.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const inside = (element, frame) => {
    const rectangle = bounds(element);
    return visible(element) && rectangle.left >= frame.left - 2 && rectangle.top >= frame.top - 2 && rectangle.right <= frame.right + 2 && rectangle.bottom <= frame.bottom + 2;
  };
  const nextButtons = root => [...root.querySelectorAll('button, [role="button"]')].filter(button => {
    const name = button.getAttribute("aria-label") || button.querySelector("svg[aria-label]")?.getAttribute("aria-label") || button.textContent?.trim();
    return /^next$/i.test(name || "") && !button.disabled && button.getAttribute("aria-disabled") !== "true" && inside(button, bounds(root));
  });
  const file = value => { try { return new URL(value).pathname.split("/").pop(); } catch { return ""; } };
  let root = document.querySelector("[data-hhc-carousel-root]");
  if (initialize) {
    document.querySelectorAll("[data-hhc-carousel-root]").forEach(element => element.removeAttribute("data-hhc-carousel-root"));
    const cover = document.querySelector('[data-hhc-post-photo="true"]');
    if (!cover) return { error: "cover_unverified" };
    const frame = bounds(cover);
    root = null;
    for (let parent = cover.parentElement, depth = 0; parent && depth < 20; parent = parent.parentElement, depth += 1) {
      const rectangle = bounds(parent);
      if (rectangle.width >= frame.width - 2 && rectangle.width <= frame.width * 1.2 && rectangle.height >= frame.height - 2 && rectangle.height <= frame.height * 1.2 && nextButtons(parent).length === 1) { root = parent; break; }
    }
    if (!root) {
      if (cover.closest("li")) return { error: "carousel_controls_unverified" };
      root = cover.parentElement;
    }
    root.setAttribute("data-hhc-carousel-root", "true");
  }
  if (!root) return { error: "carousel_frame_lost" };
  const frame = bounds(root);
  const overlap = element => {
    const rectangle = bounds(element);
    const area = Math.max(0, Math.min(rectangle.right, frame.right) - Math.max(rectangle.left, frame.left)) * Math.max(0, Math.min(rectangle.bottom, frame.bottom) - Math.max(rectangle.top, frame.top));
    return visible(element) && rectangle.width >= 320 && rectangle.height >= 320 && area / (rectangle.width * rectangle.height) > 0.95;
  };
  document.querySelectorAll("[data-hhc-carousel-photo], [data-hhc-carousel-next]").forEach(element => { element.removeAttribute("data-hhc-carousel-photo"); element.removeAttribute("data-hhc-carousel-next"); });
  const buttons = nextButtons(root);
  if (buttons.length > 1) return { error: "ambiguous_carousel_navigation" };
  if (buttons[0]) buttons[0].setAttribute("data-hhc-carousel-next", "true");
  const video = [...root.querySelectorAll("video")].find(overlap);
  if (video) return { type: "video", key: `video:${file(video.currentSrc || video.src || video.poster)}`, next: !!buttons.length };
  const photos = [...root.querySelectorAll("img")].filter(photo => photo.complete && photo.naturalWidth >= 320 && photo.naturalHeight >= 320 && overlap(photo));
  if (photos.length !== 1) return { error: "active_slide_unverified" };
  const photo = photos[0];
  photo.setAttribute("data-hhc-carousel-photo", "true");
  return { type: "photo", key: file(photo.currentSrc || photo.src), next: !!buttons.length };
}

export async function captureCarousel(page, { accessCheck, heartbeat = async () => {}, pause = delay } = {}) {
  const identity = postIdentity(page.url());
  if (!identity || identity.type !== "p") throw new Error("Open a verified photo post before capturing its carousel.");
  await page.locator('[data-hhc-post-photo="true"]').scrollIntoViewIfNeeded();
  let slide = await page.evaluate(readCarouselSlide, true);
  const photos = [];
  const seen = new Set();
  let bytes = 0;
  let videosSkipped = 0;
  for (let position = 1; position <= 20; position += 1) {
    await accessCheck?.(page);
    await heartbeat();
    if (postIdentity(page.url())?.shortcode !== identity.shortcode) return { photos, complete: false, videosSkipped, reason: "carousel_navigated_away" };
    if (slide.error || !slide.key || seen.has(slide.key)) return { photos, complete: false, videosSkipped, reason: slide.error || "carousel_repeated_slide" };
    seen.add(slide.key);
    if (slide.type === "photo") {
      const photo = page.locator('[data-hhc-carousel-photo="true"]');
      const buffer = await photo.screenshot({ type: "jpeg", quality: 95, animations: "disabled", style: '[data-hhc-carousel-root] button, [data-hhc-carousel-next] { visibility: hidden !important; }', timeout: 15000 });
      bytes += buffer.length;
      if (bytes > 22 * 1024 * 1024) return { photos, complete: false, videosSkipped, reason: "carousel_upload_limit" };
      photos.push({ key: createHash("sha256").update(slide.key).digest("hex"), bytes: buffer });
    } else { videosSkipped += 1; }
    if (!slide.next) return { photos, complete: true, videosSkipped };
    if (position === 20) break;
    await page.locator('[data-hhc-carousel-next="true"]').click();
    const previous = slide.key;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await pause(350);
      await accessCheck?.(page);
      slide = await page.evaluate(readCarouselSlide, false);
      if (!slide.error && slide.key !== previous) break;
    }
  }
  return { photos, complete: false, videosSkipped, reason: "carousel_slide_limit" };
}
