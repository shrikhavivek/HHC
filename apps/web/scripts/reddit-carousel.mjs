import { postId } from "./reddit-gallery-rules.mjs";

export function readRedditSlide(id) {
  const post = document.querySelector(`shreddit-post[id="t3_${id}"]`);
  if (!post) return {error:"The requested Reddit post is no longer open"};
  const walk = root => [...(root.shadowRoot ? walk(root.shadowRoot) : []), ...[...root.querySelectorAll("*")].flatMap(element => [element, ...(element.shadowRoot ? walk(element.shadowRoot) : [])])];
  const all = walk(post);
  const frame = all.find(element => element.tagName.toLowerCase() === "gallery-carousel") || post;
  const elements = walk(frame);
  const bounds = frame.getBoundingClientRect();
  const visible = element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const overlap = Math.max(0, Math.min(box.right, bounds.right) - Math.max(box.left, bounds.left)) * Math.max(0, Math.min(box.bottom, bounds.bottom) - Math.max(box.top, bounds.top));
    return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden" && overlap / (box.width * box.height) > .95;
  };
  const name = element => element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent?.trim() || "";
  const buttons = elements.filter(el => (el.tagName === "BUTTON" || el.getAttribute("role") === "button") && visible(el));
  const next = buttons.filter(el => /^(next|next image|next slide|next photo|next page)$/i.test(name(el)));
  const previous = buttons.filter(el => /^(previous|previous image|previous slide|previous photo|previous page)$/i.test(name(el)));
  const first = buttons.find(el => /^page 1(?:\s*\(current page\))?$/i.test(name(el)));
  // Reddit renders the pagination pill in a shadow root over the photograph.
  // Mark only its small control containers, never the image or the slide frame.
  for (const button of buttons.filter(el => /^page \d+/i.test(name(el)))) {
    for (let parent=button.parentElement; parent && parent !== frame; parent=parent.parentElement) {
      const box=parent.getBoundingClientRect();
      if (box.height > 60 || parent.matches('gallery-carousel, faceplate-carousel') || parent.querySelector('img,video,slot')) break;
      parent.setAttribute('data-hhc-reddit-overlay','true');
    }
  }
  const enabled = el => !el.disabled && el.getAttribute("aria-disabled") !== "true";
  if (next.length > 1) return {error:"The post's carousel navigation is ambiguous"};
  for (const element of all) { element.removeAttribute("data-hhc-reddit-photo"); element.removeAttribute("data-hhc-reddit-next"); element.removeAttribute("data-hhc-reddit-first"); }
  if (first) first.setAttribute("data-hhc-reddit-first", "true");
  if (elements.some(el => el.tagName === "VIDEO" && visible(el))) return {error:"This carousel contains a video; the existing draft has been preserved"};
  const photos = elements.filter(el => {
    if (el.tagName !== "IMG" || el.getAttribute('role') === 'presentation' || !el.complete || el.naturalWidth < 320 || el.naturalHeight < 320 || !visible(el)) return false;
    try { const url = new URL(el.currentSrc || el.src); return ["i.redd.it", "preview.redd.it"].includes(url.hostname) && /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(url.pathname); } catch { return false; }
  });
  if (photos.length !== 1) return {error:"Exactly one visible photo must be identified inside this post"};
  const photo = photos[0];
  photo.setAttribute("data-hhc-reddit-photo", "true");
  if (next[0] && enabled(next[0])) next[0].setAttribute("data-hhc-reddit-next", "true");
  const gallery = post.hasAttribute("gallery") || frame !== post;
  if (gallery && next.length + previous.length === 0) return {error:"Carousel controls are missing; a cover photo cannot be treated as a complete gallery"};
  const item = photo.closest('li[slot^="page-"]');
  const original = item?.querySelector('img[src^="https://i.redd.it/"]')?.getAttribute('src');
  const total = elements.filter(el=>el.matches('li[slot^="page-"]')).length;
  return {url:original || `https://i.redd.it${new URL(photo.currentSrc || photo.src).pathname}`, next:!!next[0] && enabled(next[0]), previous:previous.some(enabled), first:!!first, position:item ? Number(item.slot.slice(5)) : null, total, gallery, controls:true};
}

export async function captureRedditCarousel(page, {pause = ms => page.waitForTimeout(ms), accessCheck = async () => {}, onPhoto = () => {}} = {}) {
  const id = postId(page.url());
  await page.locator(`shreddit-post[id="t3_${id}"]`).scrollIntoViewIfNeeded();
  const photos = [];
  const seen = new Set();
  let totalBytes = 0;
  let slide = await page.evaluate(readRedditSlide, id);
  // Reddit attaches the post before its images and carousel controls finish loading.
  for (let attempt=0; attempt<20 && slide.error && !slide.error.includes("video"); attempt++) {
    await pause(350);
    slide = await page.evaluate(readRedditSlide, id);
  }
  if (!slide.error && slide.first && (slide.previous || slide.position > 1)) {
    await page.locator('[data-hhc-reddit-first="true"]').click();
    for (let attempt=0; attempt<20; attempt++) {
      await pause(350);
      slide = await page.evaluate(readRedditSlide, id);
      if (!slide.error && slide.position === 1) break;
    }
  }
  for (let index=0; index<20; index++) {
    await accessCheck();
    if (postId(page.url()) !== id) throw new Error("The browser navigated away from the requested post");
    if (slide.error) throw new Error(slide.error);
    if (index === 0 && slide.previous) throw new Error("Return to the first carousel photo before importing");
    if (slide.gallery && !slide.controls) throw new Error("Carousel controls are missing; a cover photo cannot be treated as a complete gallery");
    if (seen.has(slide.url)) throw new Error("The carousel repeated a slide; nothing was imported");
    seen.add(slide.url);
    const photo = page.locator('[data-hhc-reddit-photo="true"]');
    await photo.scrollIntoViewIfNeeded();
    const clip = await photo.evaluate(image => {
      const box = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      if (style.objectFit !== 'contain') return {x:box.x+scrollX,y:box.y+scrollY,width:box.width,height:box.height};
      const scale = Math.min(box.width/image.naturalWidth,box.height/image.naturalHeight);
      const width=image.naturalWidth*scale, height=image.naturalHeight*scale;
      return {x:box.x+scrollX+(box.width-width)/2,y:box.y+scrollY+(box.height-height)/2,width,height};
    });
    const buffer = await page.screenshot({clip,type:"jpeg",quality:95,animations:"disabled",style:'button, [role="button"], [data-hhc-reddit-overlay] { visibility: hidden !important; }',timeout:15000});
    totalBytes += buffer.length;
    if (totalBytes > 22 * 1024 * 1024) throw new Error("The carousel exceeds the upload limit");
    photos.push({url:slide.url, bytes:buffer});
    onPhoto(photos.length, slide.total);
    if (!slide.next) {
      if (slide.total && photos.length !== slide.total) throw new Error("Not every carousel slide was captured; the existing draft was preserved");
      return {photos, complete:true, postId:id};
    }
    await page.locator('[data-hhc-reddit-next="true"]').click();
    const previous = slide.url;
    for (let attempt=0; attempt<60; attempt++) {
      await pause(350);
      slide = await page.evaluate(readRedditSlide, id);
      if (!slide.error && slide.url !== previous) break;
    }
  }
  throw new Error("Carousel exceeds 20 slides; the existing draft was preserved");
}
