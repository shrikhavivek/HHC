import { test, expect } from "@playwright/test";
test.use({ viewport: { width: 1440, height: 1000 } });
const username = process.env.HHC_TEST_USERNAME || "hhc-demo";
const password = process.env.HHC_TEST_PASSWORD || "HHC-Demo-2026!";
let sessionCookies: Awaited<ReturnType<import("@playwright/test").BrowserContext["cookies"]>> | undefined;

test("timeless login layout fits desktop and mobile", async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Welcome to the studio." })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole("button", { name: "Unleash your editorial eye" }).scrollIntoViewIfNeeded();
    await expect(page.locator("input")).toHaveCount(0);
    const backgroundBounds = await page.locator(".auth-editorial-image").boundingBox();
    const pageBounds = await page.locator(".auth-shell").boundingBox();
    expect(backgroundBounds).toEqual(pageBounds);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: `test-results/timeless-login-${width}.png`, fullPage: true, animations: "disabled" });
  }
});

for (const width of [1440, 1024, 768, 390, 320]) {
  test(`pop studio pages fit at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Welcome to the studio." })).toBeVisible();
    await expect(page.locator(".auth-editorial-image")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.locator(".auth-editorial-image").evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await page.getByRole("button", { name: "Unleash your editorial eye" }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: `test-results/pop-login-${width}.png`, fullPage: true, animations: "disabled" });
    await login(page);
    await expect(page.locator(".studio-hero")).toBeVisible();
    await expect(page.locator(".studio-hero img")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: `test-results/pop-dashboard-${width}.png`, fullPage: true });
  });
}

test("flowing login recovers from connection errors with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  expect(await page.locator(".auth-form").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await expect(page.locator("input")).toHaveCount(0);
  await page.route("**/api/auth/enter", route => route.abort());
  await page.getByRole("button", { name: "Unleash your editorial eye" }).click();
  await expect(page.locator(".auth-error")).toContainText("Please try again");
  await expect(page.locator(".auth-error")).toBeFocused();
  await expect(page.getByRole("button", { name: "Unleash your editorial eye" })).toBeEnabled();
});

async function login(page: import("@playwright/test").Page, workspace: "editor" | "instagram" = "editor") {
  const ready = () => workspace === "instagram" ? expect(page.getByRole("region", { name: "Instagram discovery", exact: true })).toBeVisible() : expect(page.getByRole("button", { name: "Write story" })).toBeEnabled({ timeout: 15000 });
  if (sessionCookies) {
    await page.context().addCookies(sessionCookies);
    if ((await page.request.get("/api/auth/session")).ok()) {
      await page.goto("/dashboard");
      await ready();
      return;
    }
    await page.context().clearCookies();
  }
  await page.goto("/");
  await page.getByRole("button", { name: "Unleash your editorial eye" }).click();
  await expect(page).toHaveURL(/dashboard/);
  sessionCookies = await page.context().cookies();
  await ready();
}

test("WordPress return route keeps callback URLs private", async ({ request }) => {
  const response = await request.get("/api/wordpress/callback?state=invalid", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers().location).toMatch(/\/wordpress\/result\?status=expired$/);
});

test("editorial polish supports mobile navigation and empty search", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
  await navigation.getByRole("button", { name: "Women's fashion", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The womenswear edit." })).toBeVisible();
  await navigation.getByRole("button", { name: "Today's edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Search outfits" }).fill("no-matching-outfit-zzzz");
  await expect(page.getByText("No looks match your search")).toBeVisible();
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search outfits" })).toHaveValue("");
  await expect(page.locator(".case-card").first()).toBeVisible();
});

test("editorial polish offers retry when refreshing fails", async ({ page }) => {
  await login(page);
  let unavailable = true;
  await page.route("**/api/backend/dashboard", route => unavailable ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Temporarily unavailable" }) }) : route.continue());
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Your edit is temporarily unavailable" })).toContainText("We couldn’t refresh your edit");
  unavailable = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".queue-error")).toHaveCount(0);
  await expect(page.locator(".case-card").first()).toBeVisible();
});

test("editorial polish loads its typography and artwork locally", async ({ page }) => {
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('500 16px "Manrope"') && document.fonts.check('500 48px "Cormorant Garamond"'))).toBe(true);
  expect(await page.locator(".auth-visual h1").evaluate(element => getComputedStyle(element).fontFamily)).toContain("Cormorant Garamond");
  expect(await page.locator(".auth-manifesto > span").evaluate(element => getComputedStyle(element).fontFamily)).not.toContain("Pinyon Script");
  expect(await page.locator(".auth-form h2").evaluate(element => getComputedStyle(element).fontFamily)).not.toContain("Pinyon Script");
  await expect.poll(() => page.locator(".auth-editorial-image").evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  expect((await page.request.get("/icon.svg")).status()).toBe(200);
});
test("studio entrance presents service errors without credential fields", async ({ page }) => {
  await page.goto("/");
  await page.route("**/api/auth/enter", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "The studio could not be reached. Please try again." }) }));
  await page.getByRole("button", { name: "Unleash your editorial eye" }).click();
  await expect(page.locator(".auth-error")).toHaveText("The studio could not be reached. Please try again.");
  await expect(page.locator(".auth-error")).toBeFocused();
  await expect(page.locator("input")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unleash your editorial eye" })).toBeEnabled();
});

test("editorial polish keeps a uniform canvas without header photos", async ({ page }) => {
  await login(page);
  const backgrounds = await page.locator(".studio-shell, .studio-sidebar, .command-bar, .queue-panel, .review-panel, .metrics article").evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));
  expect(new Set(backgrounds).size).toBe(1);
  await expect(page.locator(".studio-hero img")).toHaveCount(0);
  await expect(page.getByText("IN THIS EDITION", { exact: true })).toHaveCount(0);
  const look = page.locator(".case-card").nth(1);
  const person = await look.locator(".case-copy > strong").innerText();
  await look.click();
  await expect(page.locator(".review-heading h2")).toHaveText(person);
  await expect(look).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".look-facts")).toContainText("Discovery signal");
  await expect(page.locator(".look-facts")).toContainText("Not editorial verification");
});

test("editorial polish stays dark even with a previously saved light preference", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hhc-studio-theme", "light"));
  await page.goto("/");
  const loginBackground = await page.locator(".auth-form").evaluate(element => getComputedStyle(element).backgroundColor);
  await login(page);
  await expect(page.locator(".studio-shell")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("group", { name: "Color theme" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Light", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".studio-shell")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Write story" })).toBeEnabled();
  await page.screenshot({ path: "test-results/theme-dark-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Write story" }).click();
  expect(await page.getByRole("dialog").evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(33, 30, 34)");
  await page.screenshot({ path: "test-results/theme-dark-dialog.png" });
  await page.getByRole("button", { name: "Close editorial workspace" }).click();
  await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
  await expect(page.locator(".collage-editor-modal")).toBeVisible();
  expect(await page.locator(".collage-editor-modal").evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(33, 30, 34)");
  await page.screenshot({ path: "test-results/theme-dark-collage.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator(".collage-editor-modal")).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.locator(".studio-shell")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/theme-dark-mobile.png", fullPage: true });
  await page.context().clearCookies();
  await page.goto("/");
  await expect(page.locator(".auth-shell")).toBeVisible();
  await expect(page.getByRole("group", { name: "Color theme" })).toHaveCount(0);
  expect(await page.locator(".auth-form").evaluate(element => getComputedStyle(element).backgroundColor)).toBe(loginBackground);
});

test("editorial polish theme remains usable when storage is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("Storage blocked"); };
    Storage.prototype.setItem = () => { throw new Error("Storage blocked"); };
  });
  await login(page);
  await expect(page.locator(".studio-shell")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("group", { name: "Color theme" })).toHaveCount(0);
});

test("editorial polish keeps every collage editing panel dark and readable", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
  const editor = page.locator(".collage-editor-modal");
  await editor.getByRole("button", { name: /^Resize or crop/ }).first().click();
  for (const selector of [".watermark-editor-panel", ".editor-upload-panel"]) {
    if (await editor.locator(selector).getAttribute("open") === null) await editor.locator(`${selector} > summary`).click();
  }
  const surfaces = editor.locator(".collage-context-panel, .collage-filter-panel, .watermark-editor-panel, .editor-upload-panel, .collage-context-content > section, .panel-tuning, details > summary, :scope > footer");
  const backgrounds = await surfaces.evaluateAll(elements => elements.map(element => ({ selector: element.className || element.tagName, color: getComputedStyle(element).backgroundColor })));
  expect(backgrounds.length).toBeGreaterThan(8);
  for (const surface of backgrounds) expect(["rgb(33, 30, 34)", "rgb(45, 40, 47)"]).toContain(surface.color);
  const contrasts = await editor.locator(".collage-context-content strong, details > summary b, details > summary small, .collage-rights-notice, .panel-tuning label > span, .filter-presets button, .watermark-note, .editor-upload-panel label, .all-panels-used > span, :scope > footer > div:first-child").evaluateAll(elements => {
    const luminance = (color: string) => {
      const channels = (color.match(/[\d.]+/g) || []).slice(0, 3).map(value => {
        const channel = Number(value) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    return elements.map(element => {
      let ancestor: Element | null = element;
      let background = "rgba(0, 0, 0, 0)";
      while (ancestor && background === "rgba(0, 0, 0, 0)") {
        background = getComputedStyle(ancestor).backgroundColor;
        ancestor = ancestor.parentElement;
      }
      const foregroundLight = luminance(getComputedStyle(element).color);
      const backgroundLight = luminance(background);
      return { text: element.textContent?.trim().slice(0, 70), ratio: (Math.max(foregroundLight, backgroundLight) + 0.05) / (Math.min(foregroundLight, backgroundLight) + 0.05) };
    });
  });
  for (const contrast of contrasts) expect(contrast.ratio, contrast.text).toBeGreaterThanOrEqual(4.5);
  for (const preview of await editor.locator(".layout-template-preview").all()) {
    expect(await preview.evaluate(element => ({ gap: getComputedStyle(element).gap, border: getComputedStyle(element).borderWidth }))).toEqual({ gap: "0px", border: "0px" });
  }
  await editor.locator(".collage-context-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/dark-editor-rights.png" });
  await editor.locator(".editor-upload-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/dark-editor-tools.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.locator(".editor-upload-panel").scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/dark-editor-mobile.png" });
});

test("editorial polish shows the full collage while adjusting filters", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
  const panel = page.locator(".collage-filter-panel");
  const preview = panel.getByRole("img", { name: "Filtered collage preview" });
  await expect.poll(() => preview.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await preview.scrollIntoViewIfNeeded();
    const dimensions = await preview.evaluate(element => {
      const photo = element as HTMLImageElement;
      const style = getComputedStyle(photo);
      return { fit: style.objectFit, height: photo.clientHeight, frameHeight: photo.parentElement!.clientHeight, width: photo.clientWidth, frameWidth: photo.parentElement!.clientWidth };
    });
    expect(dimensions.fit).toBe("contain");
    expect(dimensions.height).toBeGreaterThan(96);
    expect(dimensions.frameHeight).toBeGreaterThanOrEqual(dimensions.height);
    expect(dimensions.frameWidth).toBeGreaterThanOrEqual(dimensions.width);
    await panel.getByRole("button", { name: "Mono", exact: true }).click();
    await expect(preview).toHaveCSS("filter", /grayscale\(1\)/);
    await preview.scrollIntoViewIfNeeded();
    await expect(preview).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `test-results/full-collage-filter-${width}.png` });
    await panel.getByRole("button", { name: "Original", exact: true }).click();
    await expect(preview).toHaveCSS("filter", /grayscale\(0\)/);
  }
});

test("editorial polish maximizes and restores without losing collage edits", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
  const editor = page.locator(".collage-editor-modal");
  const originalBounds = await editor.boundingBox();
  await editor.getByRole("button", { name: /^Resize or crop/ }).first().click();
  const caption = editor.getByLabel("Photo caption / designer credit");
  await caption.fill("Full-screen editing test");
  const undo = editor.getByRole("button", { name: /Undo/ });
  await expect(undo).toBeEnabled();
  await editor.getByRole("button", { name: "Maximize collage editor", exact: true }).click();
  const restore = editor.getByRole("button", { name: "Restore collage editor size", exact: true });
  await expect(restore).toHaveAttribute("aria-pressed", "true");
  await expect(restore).toBeFocused();
  expect(await editor.boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 1000 });
  await expect(caption).toHaveValue("Full-screen editing test");
  await expect(undo).toBeEnabled();
  await expect(editor.getByRole("button", { name: "Save & re-render", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "test-results/collage-editor-maximized.png" });
  await restore.click();
  expect(await editor.boundingBox()).toEqual(originalBounds);
  await expect(caption).toHaveValue("Full-screen editing test");
  await editor.getByRole("button", { name: "Maximize collage editor", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(editor).toBeVisible();
  expect(await editor.boundingBox()).toEqual(originalBounds);
  await expect(caption).toHaveValue("Full-screen editing test");
  page.once("dialog", dialog => dialog.accept());
  await editor.getByRole("button", { name: "Close collage editor", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit collage & sources", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Maximize collage editor", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("editorial polish full-screen editor fits mobile and short windows", async ({ page }) => {
  await login(page);
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
    const editor = page.locator(".collage-editor-modal");
    const toggle = editor.getByRole("button", { name: "Maximize collage editor", exact: true });
    await expect(toggle).toBeInViewport({ ratio: 1 });
    await toggle.focus();
    await page.keyboard.press("Enter");
    expect(await editor.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(editor.getByRole("button", { name: "Restore collage editor size", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(editor.getByRole("button", { name: "Save & re-render", exact: true })).toBeInViewport({ ratio: 1 });
    await editor.locator(".editor-upload-panel").scrollIntoViewIfNeeded();
    await expect(editor.locator(".editor-upload-panel")).toBeInViewport();
    await page.screenshot({ path: `test-results/collage-editor-maximized-${viewport.width}.png` });
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
  }
});

test("editorial polish uses readable text throughout the studio", async ({ page }) => {
  const fontSize = (selector: string) => page.locator(selector).first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await page.goto("/");
  expect(await fontSize(".auth-form-header p")).toBeGreaterThanOrEqual(16);
  expect(await fontSize(".auth-field label")).toBeGreaterThanOrEqual(15);
  expect(await fontSize(".auth-form-footnote")).toBeGreaterThanOrEqual(14);
  expect(await fontSize(".auth-form-footnote strong")).toBeGreaterThanOrEqual(14);
  await login(page);
  expect(await fontSize(".case-copy > p")).toBeGreaterThanOrEqual(16);
  expect(await fontSize(".metrics small")).toBeGreaterThanOrEqual(14);
  expect(await fontSize(".hero-deck")).toBeGreaterThanOrEqual(32);
  expect(await fontSize(".look-facts dd")).toBeGreaterThanOrEqual(16);
  expect(await fontSize(".asset-tile-copy footer > span")).toBeGreaterThanOrEqual(14);
  await page.getByRole("button", { name: "Write story", exact: true }).click();
  expect(await fontSize(".edition-form label")).toBeGreaterThanOrEqual(15);
  expect(await fontSize(".edition-form textarea")).toBeGreaterThanOrEqual(16);
  await page.getByRole("button", { name: "Close editorial workspace" }).click();
  await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
  expect(await fontSize(".collage-editor-modal p")).toBeGreaterThanOrEqual(16);
  expect(await fontSize(".panel-sort-card small")).toBeGreaterThanOrEqual(14);
  expect(await fontSize(".filter-presets button")).toBeGreaterThanOrEqual(15);
  expect(await fontSize(".collage-rights-tags span")).toBeGreaterThanOrEqual(12);
  await page.evaluate(() => { document.documentElement.style.fontSize = "125%"; });
  expect(await fontSize(".filter-presets button")).toBeGreaterThanOrEqual(18);
  await page.getByRole("button", { name: "Maximize collage editor", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/readable-editor-large-text.png" });
});

test("instagram discovery unifies scanning and dated photo drafts", async ({ page }) => {
  let requested = 0;
  let complete = false;
  await page.route("**/api/backend/instagram-browser/status", route => route.fulfill({ json: { status: complete ? "completed" : requested ? "running" : "not_run", heartbeat: Date.now() / 1000, runner_online: true, accounts_total: 16, accounts_checked: complete ? 16 : 0, current_account: "Kriti Sanon", imported: complete ? 1 : 0 } }));
  await page.route("**/api/backend/instagram-browser/scan", route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({});
    requested += 1;
    return route.fulfill({ status: 202, json: { status: "queued", heartbeat: Date.now() / 1000 } });
  });
  await page.route("**/api/backend/instagram-browser/posts", route => route.fulfill({ json: { results: [] } }));
  await login(page, "instagram");
  const panel = page.getByRole("region", { name: "Instagram discovery", exact: true });
  await expect(page.getByRole("heading", { name: "Discover Instagram posts", exact: true })).toHaveCount(1);
  await expect(page.getByText("Instagram fashion watch", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Find Instagram posts", exact: true })).toHaveCount(0);
  await expect(panel.getByLabel("Celebrity watchlist", { exact: true })).not.toBeVisible();
  await panel.getByRole("button", { name: "Scan now", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Opening Instagram");
  await expect(panel.getByRole("button", { name: "Opening Instagram…", exact: true })).toBeDisabled();
  expect(requested).toBe(1);
  const cases = await (await page.request.get("/api/backend/cases")).json();
  await page.route("**/api/backend/instagram-browser/posts", route => route.fulfill({ json: { results: [{ id: cases[0].id, celebrity: "Kriti Sanon", base_image: cases[0].base_image, collage_image: cases[0].base_image, photo_count: 3, carousel_complete: true, permalink: "https://www.instagram.com/p/fixture/", published_at: "2026-10-13T09:00:00+05:30", brands: ["Gucci"] }] } }));
  complete = true;
  await expect(panel.getByRole("heading", { name: "Kriti Sanon", exact: true })).toBeVisible({ timeout: 12000 });
  await expect(panel.getByText(/13 Oct/)).toBeVisible();
  await expect(panel.getByText("Gucci", { exact: true })).toBeVisible();
  await expect(panel.getByRole("status")).toContainText("Scan complete");
  await expect(panel.getByText("3 photos", { exact: true })).toBeVisible();
  await panel.getByLabel("Filter collected photos").fill("Dior");
  await expect(panel.getByText("No photos match that celebrity or brand.")).toBeVisible();
  await panel.getByLabel("Filter collected photos").fill("Kriti");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.screenshot({ path: `test-results/instagram-discovery-${width}.png` });
  }
  await panel.getByRole("button", { name: "Open draft", exact: true }).click();
  await expect(page.locator(".review-identity h2")).toHaveText(cases[0].celebrity);
  await expect(page.getByText("Find similar looks on Instagram", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search signed-in Instagram", exact: true })).toHaveCount(0);
});

test("instagram discovery reports offline collector without pretending to scan", async ({ page }) => {
  await page.route("**/api/backend/instagram-browser/status", route => route.fulfill({ json: { status: "not_run", runner_online: false } }));
  await page.route("**/api/backend/instagram-browser/posts", route => route.fulfill({ json: { results: [] } }));
  await page.route("**/api/backend/instagram-browser/scan", route => route.fulfill({ status: 503, json: { detail: "The local Instagram collector is offline. Start HHC Instagram Requests." } }));
  await login(page, "instagram");
  const panel = page.getByRole("region", { name: "Instagram discovery", exact: true });
  await panel.getByRole("button", { name: "Scan now", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Instagram scanning is unavailable");
  await expect(panel.getByRole("button", { name: "Scan now", exact: true })).toBeEnabled();
  await expect(panel.getByRole("status")).toHaveCount(0);
});

test("instagram watchlist reports blocked scans and saves editable coverage", async ({ page }) => {
  const config = { enabled: true, celebrities: [{ name: "Kriti Sanon", handle: "kritisanon", enabled: true }], brands: [{ name: "Gucci", handles: ["gucci"], aliases: [] }] };
  await page.route("**/api/backend/instagram-browser/config", route => {
    if (route.request().method() === "POST") {
      const saved = route.request().postDataJSON();
      expect(saved.celebrities).toHaveLength(2);
      expect(saved.celebrities[1]).toEqual({ name: "Alia Bhatt", handle: "aliaabhatt", enabled: false });
      expect(saved.brands[0].name).toBe("Gucci");
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ json: config });
  });
  await page.route("**/api/backend/instagram-browser/status", route => route.fulfill({ json: { status: "blocked", accounts_checked: 1, posts_checked: 3, imported: 0, detail: "Instagram requires verification. No bypass attempted.", exclusions: { outside_today_yesterday: 3 } } }));
  await page.route("**/api/backend/instagram-browser/posts", route => route.fulfill({ json: { results: [] } }));
  await login(page, "instagram");
  const watchlist = page.locator(".instagram-watchlist");
  await expect(watchlist.getByText("Instagram needs your attention", { exact: true })).toBeVisible();
  await expect(watchlist.getByText("Today & yesterday", { exact: true })).toBeVisible();
  await watchlist.getByText("Watchlist settings", { exact: true }).click();
  await watchlist.getByLabel("Celebrity watchlist", { exact: true }).fill("Kriti Sanon | kritisanon\nAlia Bhatt | aliaabhatt | off");
  await watchlist.getByRole("button", { name: "Save watchlist", exact: true }).click();
  await expect(watchlist.getByText(/Watchlist saved/)).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await watchlist.screenshot({ path: `test-results/instagram-watchlist-${width}.png` });
  }
});

test("private images and API reads require a session", async ({ request }) => {
  expect((await request.get("/media/static/look-1.png")).status()).toBe(401);
  expect((await request.get("/api/backend/cases")).status()).toBe(401);
  expect((await request.post("/api/auth/login", { data: { username, applicationPassword: password } })).status()).toBe(403);
});
test("editor can save a story and inspect source status", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page);
  await page.getByRole("button", { name: "Sources & schedule" }).click();
  await expect(page.getByRole("dialog")).toContainText("A fresh edition. Every day.");
  await page.getByRole("button", { name: "Close editorial workspace" }).click();
  await page.getByRole("button", { name: "Write story" }).click();
  await page.getByLabel("Headline", { exact: true }).fill("An editor's considered take");
  await page.getByLabel("The story", { exact: true }).fill("A saved editorial draft, ready for further research.");
  await page.getByRole("button", { name: "Save story", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Story saved.");
  await expect(page.getByRole("button", { name: /Send WordPress draft/ })).toBeDisabled();
  await page.screenshot({ path: "test-results/editorial-story.png", fullPage: true });
  await page.getByRole("button", { name: "Close editorial workspace" }).click();
  expect(errors).toEqual([]);
});
test("collage controls support undo and save a new version", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page);
  await page.evaluate(async () => {
    const cases = await (await fetch("/api/backend/cases")).json();
    const detail = await (await fetch("/api/backend/cases/" + cases[0].id)).json();
    const response = await fetch("/api/backend/cases/" + cases[0].id + "/collage/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ panel_ids: ["current-primary"], expected_revision: detail.collage_editor.revision || 0 }) });
    if (!response.ok) throw new Error(await response.text());
  });
  await page.reload();
  await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
  await page.getByRole("button", { name: /Resize or crop Current post/ }).first().click();
  await page.getByRole("button", { name: /Rotate 90/ }).click();
  await expect(page.getByRole("button", { name: /Rotate 90/ })).toContainText("90° · 90°");
  await page.getByRole("button", { name: "↶ Undo", exact: true }).click();
  await expect(page.getByRole("button", { name: /Rotate 90/ })).toContainText("90° · 0°");
  await page.getByLabel("Photo caption / designer credit").fill("Test credit · Demo image");
  expect((await page.getByLabel("Photo caption / designer credit").boundingBox())?.height).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: "test-results/editorial-editor.png" });
  await page.getByRole("button", { name: "Save & re-render", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit this collage." })).not.toBeVisible();
  await page.screenshot({ path: "test-results/editorial-collage.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("mobile story workspace fits the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "Write story" }).click();
  await expect(page.getByLabel("Headline", { exact: true })).toBeVisible();
  const dialog = page.getByRole("dialog");
  const bounds = await dialog.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(390);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/editorial-mobile.png" });
});

test("logout revokes a copied session", async ({ page, request }) => {
  await login(page);
  const cookie = (await page.context().cookies()).find(item => item.name === "hhc_editor_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  const headers = { Cookie: cookie!.name + "=" + cookie!.value };
  expect((await request.get("/api/backend/cases", { headers })).status()).toBe(200);
  const status = await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).status);
  expect(status).toBe(200);
  expect((await request.get("/api/backend/cases", { headers })).status()).toBe(401);
});

for (const viewport of [{ width: 1440, height: 720 }, { width: 1024, height: 600 }, { width: 390, height: 844 }]) {
  test(`collage photos scroll without clipping at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    page.on("dialog", dialog => dialog.accept());
    await login(page);
    await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
    await page.getByRole("button", { name: "Reset automatic layout", exact: true }).click();
    const photos = page.locator(".selected-panel-list");
    const tools = page.locator(".available-panel-list");
    const scroller = page.locator(".collage-editor-body");
    const metrics = await scroller.evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
    await testInfo.attach("scroll-region.json", { body: JSON.stringify(metrics), contentType: "application/json" });
    await scroller.evaluate(el => { el.scrollTop = 0; });
    const box = await scroller.boundingBox();
    await page.mouse.move(box!.x + 30, box!.y + 40);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(50);
    expect(await photos.evaluate(el => getComputedStyle(el).overflowY)).toBe("visible");
    expect(await tools.evaluate(el => getComputedStyle(el).overflowY)).toBe("visible");
    await photos.getByRole("button", { name: /Resize or crop/ }).first().click();
    await page.getByRole("button", { name: "Manual crop", exact: true }).click();
    await expect(page.locator(".manual-crop-stage")).toBeInViewport();
    // Reach the last individual photo using a real wheel event, not scrollIntoView.
    await page.mouse.move(box!.x + 30, box!.y + 40);
    await page.mouse.wheel(0, 10000);
    await expect.poll(() => scroller.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)).toBe(true);
    await scroller.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
    await expect(page.getByRole("button", { name: "Save & re-render", exact: true })).toBeInViewport();
    expect(await page.locator(".collage-editor-modal").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `test-results/editorial-scroll-${viewport.width}.png` });
  });
}

for (const width of [1440, 390]) {
  test(`manual crop preview and side-by-side save agree at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const now = new Date().toISOString();
    const panel = { id: "current-primary", role: "current_primary", label: "Current photo", person: "Alia Bhatt", designer: "Designer", image_path: "/static/crop.svg", source_url: "https://example.com/photo", publisher: "Photographer", rights_status: "editorial_review_required", source_grade: "A" };
    const item = { id: "crop-ui", title: "Look", celebrity: "Alia Bhatt", designer: "Designer", event_name: "Event", status: "context_review", match_type: "same_outfit", confidence: 0.9, risk_level: "low", base_image: "/crop.svg", source_type: "instagram", fashion_category: "women", created_at: now, published_at: now, candidates: [], assets: [], extraction: {}, permalink: "https://example.com/photo", latest_collage: { id: "c1", preview_url: "/crop.svg", bundle_url: "/api/bundle" }, collage_editor: { revision: 1, panels: [panel], default_ids: [panel.id], selected_ids: [panel.id], panel_options: {}, canvas_format: "instagram_portrait", layout_template: "balanced_grid" } };
    let submitted: any;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/media/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="red"/><rect x="150" width="300" height="400" fill="lime"/></svg>' }));
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path === "/api/auth/session") data = { username: "editor", demo: true };
      else if (path.endsWith("/dashboard")) data = { total: 1, status_counts: {}, source_mode: "rss" };
      else if (path === "/api/backend/cases") data = [item];
      else if (path.endsWith("/cases/crop-ui")) data = item;
      else if (path.endsWith("/operations")) data = { runs: [] };
      else if (path.endsWith("/instagram-browser/config")) data = { enabled: false, celebrities: [], brands: [] };
      else if (path.endsWith("/instagram-browser/posts")) data = { results: [] };
      else if (path.endsWith("/instagram-browser/status")) data = { status: "not_run" };
      else if (path.endsWith("/collage/layouts")) {
        const payload = route.request().postDataJSON();
        const photo = payload.photos[0];
        const sideHeight = Math.round(1080 * photo.height / photo.width);
        data = Object.fromEntries(["side_by_side", "balanced_grid", "hero_focus", "editorial_split"].map(layout => [layout, { width: 1080, height: layout === "side_by_side" ? sideHeight : 1350, cells: [[0, 0, 1080, layout === "side_by_side" ? sideHeight : 1350]] }]));
      }
      else if (path.endsWith("/collage/edit")) {
        submitted = route.request().postDataJSON();
        item.collage_editor = { ...item.collage_editor, ...submitted, revision: 2 };
        data = { preview_url: "/crop.svg", bundle_url: "/api/bundle", asset_count: 1, canvas_format: submitted.canvas_format, layout_template: submitted.layout_template };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
    await page.getByRole("radio", { name: /Side by side/ }).click();
    await expect(page.getByRole("radiogroup", { name: "Instagram canvas format" })).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Current collage layout preview", exact: true })).toBeVisible();
    await expect(page.getByText(/With one photo, the fixed layouts have the same arrangement/)).toBeVisible();
    await page.getByRole("button", { name: "Resize or crop Current photo", exact: true }).click();
    await page.getByRole("button", { name: "Manual crop", exact: true }).click();
    for (const name of [/Crop width/, /Crop height/]) {
      const slider = page.getByRole("slider", { name });
      await slider.focus();
      await slider.press("End");
      for (let step = 0; step < 50; step++) await slider.press("ArrowLeft");
    }
    await page.getByRole("button", { name: /Rotate 90/ }).click();
    await page.getByRole("button", { name: "Mirror horizontally", exact: true }).click();
    const preview = page.locator(".manual-crop-result canvas");
    await expect.poll(() => preview.evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])).toEqual([200, 300]);
    await expect(page.getByRole("img", { name: "Current collage layout preview", exact: true })).toHaveCSS("aspect-ratio", "1080 / 1620");
    expect(await preview.evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext("2d")!.getImageData(50, 50, 1, 1).data))).toEqual([0, 255, 0, 255]);
    for (const layout of [/Balanced grid/, /Hero focus/, /Editorial split/]) {
      await page.getByRole("radio", { name: layout }).click();
      await expect(page.getByText("Final panel preview", { exact: true })).toBeVisible();
      await expect.poll(() => preview.evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])).toEqual([480, 600]);
      const cells = page.getByRole("img", { name: "Current collage layout preview", exact: true }).locator(".live-layout-cell");
      await expect(cells.first()).toHaveClass(/fill-photo/);
      expect(await preview.evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data))).toEqual([0, 255, 0, 255]);
    }
    await page.getByRole("radio", { name: /Side by side/ }).click();
    await expect.poll(() => preview.evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])).toEqual([200, 300]);
    await page.getByRole("button", { name: "Save & re-render", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your outfit collage is ready." })).toBeVisible();
    expect(submitted.layout_template).toBe("side_by_side");
    expect(submitted.panel_options[panel.id]).toMatchObject({ crop_mode: "crop", crop_rect: { x: .25, y: .25, width: .5, height: .5 }, rotation_degrees: 90, flip_horizontal: true });
    await page.locator(".collage-result-modal").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Edit collage & sources", exact: true }).click();
    await expect(page.getByRole("radio", { name: /Side by side/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Resize or crop Current photo", exact: true }).click();
    await expect.poll(() => preview.evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])).toEqual([200, 300]);
    expect(errors).toEqual([]);
  });
}

for (const scenario of [
  { width: 1440, connected: true, action: "toolbar" },
  { width: 390, connected: false, action: "preview" },
  { width: 1440, connected: false, action: "edited story" },
  { width: 390, connected: false, action: "blocked story" },
  { width: 1440, connected: false, action: "save failure" },
]) {
  test(`WordPress draft action redirects or explains the blocker: ${scenario.action}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    const now = new Date().toISOString();
    const item = {
      id: "wp-ui-case", title: "A reviewed look", celebrity: "Alia Bhatt", designer: "Designer",
      event_name: "Appearance", status: "needs_review", match_type: "same_outfit", confidence: 0.9,
      risk_level: "low", base_image: "/fixture.svg", demo_data: false, source_type: "instagram",
      fashion_category: "women", created_at: now, published_at: now, candidates: [], assets: [], extraction: {},
      permalink: "https://www.instagram.com/p/fixture/",
      latest_collage: { id: "collage-1", preview_url: "/fixture.svg", bundle_url: "/api/cases/wp-ui-case/bundle" },
      collage_editor: { revision: 1, panels: [], default_ids: [], canvas_format: "instagram_portrait", layout_template: "balanced_grid" },
    };
    let story = { title: "A reviewed look", body: "The completed story.", alt_text: "A fashion collage", credits: "Photo credit", category_ids: [], tag_ids: [], revision: 1, reviewed_collage_id: "collage-1", sync_state: "local" };
    let sends = 0;
    let saves = 0;
    let rejectSend = scenario.action === "blocked story";
    await page.route("**/media/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#805465"/></svg>' }));
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path === "/api/auth/session") data = { username: "editor", demo: !scenario.connected };
      else if (path.endsWith("/dashboard")) data = { total: 1, status_counts: {}, source_mode: "rss" };
      else if (path === "/api/backend/cases") data = [item];
      else if (path === "/api/backend/cases/wp-ui-case") data = item;
      else if (path.endsWith("/operations")) data = { runs: [] };
      else if (path.endsWith("/instagram-browser/config")) data = { enabled: false, celebrities: [], brands: [] };
      else if (path.endsWith("/instagram-browser/posts")) data = { results: [] };
      else if (path.endsWith("/instagram-browser/status")) data = { status: "not_run" };
      else if (path.endsWith("/wordpress/connection")) data = { connected: scenario.connected, enabled: true };
      else if (path.endsWith("/wordpress/taxonomy")) data = { categories: [], tags: [] };
      else if (path.endsWith("/story")) {
        if (route.request().method() === "POST") {
          saves++;
          if (scenario.action === "save failure") {
            await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "Story changed in another window. Reload before saving." }) });
            return;
          }
          story = { ...story, ...route.request().postDataJSON(), revision: story.revision + 1 };
        }
        data = story;
      }
      else if (path === "/api/wordpress/start" && route.request().method() === "POST") {
        sends++;
        if (rejectSend) {
          await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: "Confirm the sources and usage rights for the latest collage" }) });
          return;
        }
        story = { ...story, sync_state: "draft_created" };
        expect(route.request().postDataJSON()).toEqual({ case_id: item.id, reconcile: false });
        data = { redirect_url: "/wordpress/result?status=cancelled" };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("/dashboard");
    const action = page.getByRole("region", { name: "Editorial tools" }).getByRole("button", { name: "Send WordPress draft", exact: true });
    await expect(action).toBeEnabled();
    const dialog = page.locator(".edition-dialog");
    const send = dialog.getByRole("button", { name: /Send WordPress draft/ });
    if (scenario.action === "preview") {
      await page.getByRole("button", { name: "View collage", exact: true }).click();
      await page.locator(".collage-result-modal").getByRole("button", { name: "Send WordPress draft", exact: true }).click();
    } else if (["edited story", "save failure"].includes(scenario.action)) {
      await page.getByRole("button", { name: "Write story" }).click();
      await expect(send).toBeEnabled();
      await dialog.getByLabel("Headline", { exact: true }).fill("Updated headline");
      await expect(send).toBeEnabled();
      await send.click();
      if (scenario.action === "save failure") {
        await expect(dialog.getByRole("status")).toHaveText(/Story changed in another window/);
        await expect(dialog.getByRole("status")).toBeInViewport();
        expect(sends).toBe(0);
        await expect(dialog.getByLabel("Headline", { exact: true })).toHaveValue("Updated headline");
        return;
      }
    } else {
      await action.click();
    }
    if (rejectSend) {
      await expect(dialog.getByRole("status")).toHaveText("Confirm the sources and usage rights for the latest collage");
      await expect(dialog.getByRole("status")).toBeInViewport();
      await expect(send).toBeEnabled();
      rejectSend = false;
      await send.click();
    }
    await expect(page).toHaveURL(/\/wordpress\/result\?status=cancelled/);
    await expect(page.getByText(/WordPress sign-in was cancelled/)).toBeVisible();
    expect(sends).toBe(scenario.action === "blocked story" ? 2 : 1);
    if (scenario.action === "edited story") {
      expect(saves).toBe(1);
      expect(story.title).toBe("Updated headline");
    }
  });
}
