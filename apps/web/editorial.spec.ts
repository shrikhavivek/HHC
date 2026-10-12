import { test, expect } from "@playwright/test";
test.use({ viewport: { width: 1440, height: 1000 } });
const username = process.env.HHC_TEST_USERNAME || "hhc-demo";
const password = process.env.HHC_TEST_PASSWORD || "HHC-Demo-2026!";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^(Sign in|Enter the studio)$/ }).click();
  await expect(page).toHaveURL(/dashboard/);
  await expect(page.getByRole("button", { name: "Write story" })).toBeEnabled();
}
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
