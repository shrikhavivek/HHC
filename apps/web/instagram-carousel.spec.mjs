import { test, expect } from "@playwright/test";
import { captureCarousel } from "./scripts/instagram-carousel.mjs";

async function fixture(page, { video = false, stuck = false, single = false } = {}) {
  await page.route("https://www.instagram.com/**", route => {
    if (route.request().url().endsWith(".svg")) {
      const color = route.request().url().includes("second") ? "blue" : "red";
      return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="${color}"/></svg>` });
    }
    return route.fulfill({ contentType: "text/html", body: `<main>
      <div id="carousel" style="position:relative;width:400px;height:500px;overflow:hidden">
      <img data-hhc-post-photo="true" src="/first.svg" style="position:absolute;width:400px;height:500px"/>
      ${single ? "" : video ? '<video poster="/second.svg" style="position:absolute;left:400px;width:400px;height:500px"></video>' : '<img src="/second.svg" style="position:absolute;left:400px;width:400px;height:500px"/>'}
      ${single ? "" : '<button aria-label="Next" style="position:absolute;right:0;top:220px">Next</button>'}
      </div><div style="position:absolute;left:700px;top:0"><img src="/suggestion.svg"/><button aria-label="Next">Recommendation</button></div>
      <script>const frame=document.getElementById('carousel');const next=frame.querySelector('button');if(next)next.onclick=()=>{if(${stuck})return;const slides=frame.querySelectorAll('img,video');slides[0].style.left='-400px';slides[1].style.left='0';next.remove();};</script>
      </main>` });
  });
  await page.goto("https://www.instagram.com/p/testcarousel/");
  await expect(page.locator("#carousel img").first()).toBeVisible();
}

test("carousel captures all photo slides in order without recommendation photos", async ({ page }) => {
  await fixture(page);
  const result = await captureCarousel(page);
  expect(result.complete).toBe(true);
  expect(result.photos).toHaveLength(2);
  expect(result.photos[0].key).not.toBe(result.photos[1].key);
  expect(result.photos.every(photo => photo.bytes.length > 100)).toBe(true);
});

test("carousel skips video slides but keeps the photo", async ({ page }) => {
  await fixture(page, { video: true });
  const result = await captureCarousel(page);
  expect(result.complete).toBe(true);
  expect(result.photos).toHaveLength(1);
  expect(result.videosSkipped).toBe(1);
});

test("carousel marks a stalled Next button incomplete without duplicate photos", async ({ page }) => {
  await fixture(page, { stuck: true });
  const result = await captureCarousel(page, { pause: async () => {} });
  expect(result.complete).toBe(false);
  expect(result.photos).toHaveLength(1);
  expect(result.reason).toBe("carousel_repeated_slide");
});

test("single photo does not follow another post's Next button", async ({ page }) => {
  await fixture(page, { single: true });
  const result = await captureCarousel(page);
  expect(result.complete).toBe(true);
  expect(result.photos).toHaveLength(1);
});

test("carousel stops immediately on access restrictions", async ({ page }) => {
  await fixture(page);
  await expect(captureCarousel(page, { accessCheck: async () => { throw new Error("Verification required"); } })).rejects.toThrow("Verification required");
});
