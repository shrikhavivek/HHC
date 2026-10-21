import { test, expect, Page } from "@playwright/test";

async function studio(page: Page) {
  const now = new Date().toISOString();
  const item = { id: "flow-case", title: "A considered look", celebrity: "Alia Bhatt", designer: "Designer", event_name: "Appearance", status: "needs_review", match_type: "same_outfit", confidence: .9, risk_level: "low", base_image: "/fixture.svg", source_type: "instagram", fashion_category: "women", created_at: now, published_at: now, candidates: [], assets: [], extraction: {}, permalink: "https://www.instagram.com/p/fixture/", latest_collage: { id: "collage-1", preview_url: "/fixture.svg", bundle_url: "/api/cases/flow-case/bundle" }, collage_editor: { revision: 1, panels: [], default_ids: [], canvas_format: "instagram_portrait", layout_template: "balanced_grid" } };
  const state = { story: { title: "A considered look", body: "A complete editorial story.", alt_text: "Two fashion photographs side by side", credits: "Photographer / agency", category_ids: [], tag_ids: [], revision: 1, reviewed_collage_id: null as string | null, sync_state: "local" }, saves: 0, sends: 0, saveStatus: 200, sendStatus: 200, signedIn: true, hold: null as Promise<void> | null };
  await page.route("**/media/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="400" height="500" fill="#805465"/><rect x="400" width="400" height="500" fill="#c8aa76"/></svg>' }));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {}; let status = 200;
    if (path === "/api/auth/session") { status = state.signedIn ? 200 : 401; data = { username: "editor", studio: true, demo: false }; }
    else if (path === "/api/auth/login") { state.signedIn = true; data = { username: "editor", ok: true }; }
    else if (path.endsWith("/dashboard")) data = { total: 1, status_counts: {}, source_mode: "rss" };
    else if (path === "/api/backend/cases") data = [item];
    else if (path === "/api/backend/cases/flow-case") data = item;
    else if (path.endsWith("/operations")) data = { runs: [] };
    else if (path.endsWith("/instagram-browser/config")) data = { enabled: true, celebrities: Array.from({ length: 121 }, (_, i) => ({ name: `Person ${i}`, handle: `person${i}`, enabled: true })), brands: [] };
    else if (path.endsWith("/instagram-browser/posts")) data = { results: [] };
    else if (path.endsWith("/instagram-browser/status")) data = { status: "interrupted", runner_online: true, accounts_checked: 2, accounts_total: 121, posts_checked: 7, imported: 2, detail: "Collector diagnostic detail", exclusions: { reels: 3 } };
    else if (path.endsWith("/wordpress/connection")) data = { connected: false, enabled: true };
    else if (path.endsWith("/story")) {
      if (route.request().method() === "POST") {
        state.saves++;
        const payload = route.request().postDataJSON();
        if (state.hold) await state.hold;
        status = state.saveStatus;
        if (status === 200 && payload.expected_revision !== state.story.revision) status = 409;
        if (status === 200) state.story = { ...state.story, ...payload, revision: state.story.revision + 1 };
      }
      data = status === 200 ? state.story : { detail: status === 409 ? "Another editor changed this story. Reopen it to load the latest revision." : "Session expired" };
    } else if (path === "/api/wordpress/start") {
      state.sends++; status = state.sendStatus;
      data = status === 200 ? { redirect_url: "/wordpress/result?status=cancelled&case=flow-case" } : { detail: "Approve each historical match before the WordPress handoff" };
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "View collage", exact: true })).toBeEnabled();
  return state;
}
async function write(page: Page) { await page.getByRole("button", { name: "View collage", exact: true }).click(); await page.locator(".collage-result-modal").getByRole("button", { name: "Write your story" }).click(); await expect(page.getByLabel("Headline", { exact: true })).toBeVisible(); }

test("autosave preserves typing during an in-flight save and resumes the same story", async ({ page }) => {
  const state = await studio(page); await write(page);
  let release!: () => void; state.hold = new Promise(resolve => { release = resolve; });
  await page.getByLabel("The story", { exact: true }).fill("First edit");
  await expect.poll(() => state.saves).toBe(1);
  await page.getByLabel("The story", { exact: true }).fill("Latest edit while saving");
  state.hold = null; release();
  await expect.poll(() => state.story.body).toBe("Latest edit while saving");
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved");
  expect(state.saves).toBe(2);
  await page.reload();
  await expect(page.getByLabel("The story", { exact: true })).toHaveValue("Latest edit while saving");
  await expect(page).toHaveURL(/case=flow-case&step=story/);
});

test("missing fields are explained inline and blank headlines still autosave", async ({ page }) => {
  const state = await studio(page); await write(page);
  await page.getByLabel("Headline", { exact: true }).fill("");
  await page.getByLabel("Photo credits", { exact: true }).fill("");
  await expect.poll(() => state.story.title).toBe("");
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(page.getByText("Add a headline.", { exact: true })).toBeVisible();
  await expect(page.getByText("Add the photo credits.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Headline", { exact: true })).toBeFocused();
  expect(state.sends).toBe(0);
});

test("expired sessions preserve unfinished edits through editor sign-in", async ({ page }) => {
  const state = await studio(page); await write(page);
  state.saveStatus = 401; state.signedIn = false;
  await page.getByLabel("The story", { exact: true }).fill("An unfinished story worth keeping");
  const again = page.getByRole("link", { name: "Sign in again to continue this story" });
  await expect(again).toBeVisible();
  page.on("dialog", dialog => dialog.accept());
  await again.click();
  await page.getByLabel("Username", { exact: true }).fill("editor");
  await page.getByLabel("Password", { exact: true }).fill("test-only-password");
  state.saveStatus = 200;
  await page.getByRole("button", { name: "Unleash your editorial eye" }).click();
  await expect(page.getByLabel("The story", { exact: true })).toHaveValue("An unfinished story worth keeping");
  await expect.poll(() => state.story.body).toBe("An unfinished story worth keeping");
});

test("save conflicts keep local edits until the editor chooses a version", async ({ page }) => {
  const state = await studio(page); await write(page);
  state.story = { ...state.story, revision: 2, body: "Newer remote version" };
  await page.getByLabel("The story", { exact: true }).fill("My local edits");
  await expect(page.getByRole("button", { name: "Keep my edits" })).toBeVisible();
  expect(state.story.body).toBe("Newer remote version");
  await page.getByRole("button", { name: "Keep my edits" }).click();
  await expect.poll(() => state.story.body).toBe("My local edits");
  expect(state.story.revision).toBe(3);
});

for (const width of [1440, 390]) {
  test(`collage leads to a complete review and returns to the same draft at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await studio(page);
    await page.getByRole("button", { name: "View collage", exact: true }).click();
    await page.locator(".collage-result-modal").getByRole("button", { name: "Write your story" }).click();
    await page.getByRole("button", { name: "Review draft", exact: true }).click();
    const preview = page.getByRole("region", { name: "Final draft preview" });
    await expect(preview.getByRole("heading", { name: state.story.title })).toBeVisible();
    await expect(preview.getByRole("img")).toHaveAttribute("src", "/media/fixture.svg");
    await expect(preview).toContainText(state.story.body);
    await expect(preview).toContainText(state.story.credits);
    expect(state.sends).toBe(0);
    await page.getByRole("button", { name: "Continue to WordPress" }).click();
    await expect(page.getByText("Confirm the photos and credits before continuing.")).toBeVisible();
    await page.getByRole("checkbox", { name: /I have checked/ }).check();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved");
    expect(await page.getByRole("dialog").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.getByRole("dialog").screenshot({ path: `test-results/final-review-${width}.png` });
    await page.getByRole("button", { name: "Continue to WordPress" }).click();
    await expect(page).toHaveURL(/status=cancelled&case=flow-case/);
    await page.getByRole("link", { name: "Return to your story" }).click();
    await expect(page.getByRole("region", { name: "Final draft preview" })).toContainText(state.story.body);
    expect(state.sends).toBe(1);
  });
}

test("WordPress server validation stays visible without losing the review", async ({ page }) => {
  const state = await studio(page); await write(page);
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await page.getByRole("checkbox", { name: /I have checked/ }).check();
  state.sendStatus = 422;
  await page.getByRole("button", { name: "Continue to WordPress" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Approve each historical match" })).toBeInViewport();
  await expect(page.getByRole("region", { name: "Final draft preview" })).toBeVisible();
  expect(state.sends).toBe(1);
});

test("a newly rendered collage clears stale review confirmation without blocking autosave", async ({ page }) => {
  const state = await studio(page);
  state.story.reviewed_collage_id = "older-collage";
  await write(page);
  await expect.poll(() => state.story.reviewed_collage_id).toBe(null);
  await page.getByLabel("The story", { exact: true }).fill("Updated after a collage edit");
  await expect.poll(() => state.story.body).toBe("Updated after a collage edit");
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /I have checked/ })).not.toBeChecked();
});

test("Instagram progress shows useful counts and hides diagnostics under details", async ({ page }) => {
  await studio(page);
  const scan = page.getByRole("region", { name: "Instagram discovery" });
  await expect(scan).toContainText("2 of 121 accounts checked · 7 posts checked · 2 usable posts collected");
  await expect(scan.getByText("Collector diagnostic detail")).not.toBeVisible();
  await scan.getByText("View details", { exact: true }).click();
  await expect(scan.getByText("Collector diagnostic detail")).toBeVisible();
});

for (const failed of [false, true]) {
  test(`WordPress progress shows completion or recovery without blind retries: failed=${failed}`, async ({ page }) => {
    let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    await page.route("**/api/wordpress/complete", async route => { calls++; await ready; await route.fulfill({ status: failed ? 502 : 200, json: failed ? { return_url: "/wordpress/result?status=failed&case=flow-case" } : { edit_url: "https://wordpress.example/wp-admin/post.php?post=123&action=edit", return_url: "/dashboard?case=flow-case&step=review" } }); });
    await page.goto("/wordpress/complete");
    await expect(page.getByRole("heading", { name: "Creating your draft…" })).toBeVisible();
    await expect(page.getByRole("progressbar")).toBeVisible();
    release();
    if (failed) await expect(page.getByRole("link", { name: "Return to your story" })).toHaveAttribute("href", /case=flow-case/);
    else await expect(page.getByRole("link", { name: "Open draft in WordPress" })).toHaveAttribute("href", /post=123&action=edit/);
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    expect(calls).toBe(1);
  });
}
