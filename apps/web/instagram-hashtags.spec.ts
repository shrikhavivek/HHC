import { test, expect } from "@playwright/test";

const fingerprint = "a".repeat(64);
const lead = { permalink: "https://www.instagram.com/p/otherwearer/", author: "designerarchive", caption: "Another wearer in a red silk saree #sabyasachi #silksaree", hashtag: "silksaree", published_at: "2020-01-01T10:00:00Z" };
const plan = {
  hashtags: [{ tag: "sabyasachi", reason: "Designer", url: "https://www.instagram.com/explore/tags/sabyasachi/" },
    { tag: "silksaree", reason: "Fabric + garment", url: "https://www.instagram.com/explore/tags/silksaree/" }],
  google_queries: [{ query: 'site:instagram.com/p/ "Sabyasachi" "silk saree" -"Alia Bhatt"', url: 'https://www.google.com/search?q=site%3Ainstagram.com%2Fp%2F+%22Sabyasachi%22+%22silk+saree%22+-%22Alia+Bhatt%22' }],
  excluded_celebrity: "Alia Bhatt", excluded_terms: ["alia", "bhatt", "aliabhatt"], default_hashtags: ["sabyasachi", "silksaree"], context_fingerprint: fingerprint, max_selected: 6, google_configured: true, search: null, google_search: null,
};
const panel = { id: "current", role: "current", label: "Source photo", person: "Alia Bhatt", image_path: "/static/look-1.png", source_url: "https://www.reddit.com/r/BollywoodFashion/comments/source/", publisher: "Reddit", credit: "Pending", rights_status: "editorial_review_required", required: true };
const outfit = {
  id: "look", title: "Alia Bhatt in a red silk saree", celebrity: "Alia Bhatt", designer: "Sabyasachi", event_name: "Premiere",
  status: "context_review", fashion_category: "women", event_date: "2026-10-13", created_at: "2026-10-13T10:00:00Z", confidence: .5,
  risk_level: "medium", base_image: panel.image_path, demo_data: false, source_type: "reddit_rss", match_type: "source_only", context_revision: 0,
  body: "Red silk saree", permalink: panel.source_url, extraction: {}, assets: [], candidates: [], latest_collage: null,
  collage_editor: { panels: [panel], selected_ids: [panel.id], default_ids: [panel.id], panel_options: {}, revision: 0,
    canvas_format: "instagram_portrait", layout_template: "balanced_grid", customized: false,
    collage_adjustments: { brightness: 1, contrast: 1, saturation: 1, grayscale: 0 } },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path === "/api/auth/session") data = { username: "editor", demo: true };
    else if (path.endsWith("/dashboard")) data = { total: 1, status_counts: {}, source_mode: "manual" };
    else if (path === "/api/backend/cases") data = [outfit];
    else if (path === "/api/backend/cases/look") data = outfit;
    else if (path.endsWith("/hashtags")) data = plan;
    else if (path.endsWith("/instagram-browser/config")) data = { enabled: true, celebrities: [], brands: [] };
    else if (path.endsWith("/instagram-browser/posts")) data = { results: [] };
    else if (path.endsWith("/operations")) data = { runs: [] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
});

for (const width of [1440, 390]) {
  test(`hashtag research fits at ${width} and hands reviewed source URL to the photo editor`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/hashtags/search", async route => {
      expect(route.request().postDataJSON()).toEqual({ hashtags: ["sabyasachi", "silksaree"], context_fingerprint: fingerprint });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "completed", detail: "Review these sources.", results: [lead], hashtags: ["sabyasachi", "silksaree"], match_mode: "all", tags_checked: 2, posts_checked: 3 }) });
    });
    await page.goto("/dashboard");
    const research = page.locator(".instagram-hashtag-research");
    await research.locator("summary").click();
    await expect(research.getByLabel("Hashtags to search")).toHaveValue("#sabyasachi #silksaree");
    await expect(research.getByRole("link", { name: "#silksaree ↗", exact: true })).toHaveAttribute("href", "https://www.instagram.com/explore/tags/silksaree/");
    await expect(research.getByRole("link").filter({ hasText: "site:instagram.com" })).toContainText('-"Alia Bhatt"');
    await research.getByRole("button", { name: "Search signed-in Instagram", exact: true }).click();
    await expect(research.getByRole("link", { name: "Review Instagram post ↗" })).toHaveAttribute("href", lead.permalink);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await research.getByRole("button", { name: "Add a credited photo" }).click();
    await expect(page.locator('.editor-upload-panel input[name="source_url"]')).toHaveValue(lead.permalink);
    await expect(page.locator('.editor-upload-panel input[name="credit"]')).toBeVisible();
    await expect(page.locator('.editor-upload-panel input[name="person"]')).toHaveAttribute("required", "");
    // No result becomes a panel until the editor supplies an image and credit.
    await expect(page.locator(".panel-sort-card")).toHaveCount(1);
  });
}

test("Google search returns reviewable links and reports connection errors", async ({ page }) => {
  let fail = false;
  await page.route("**/hashtags/google", async route => {
    expect(route.request().postDataJSON()).toEqual({ context_fingerprint: fingerprint, hashtags: ["sabyasachi", "silksaree"] });
    await route.fulfill({ status: fail ? 503 : 200, contentType: "application/json", body: JSON.stringify(fail
      ? { detail: "Google search connection unavailable" }
      : { status: "completed", detail: "Indexed research leads only.", results: [{ ...lead, title: "Sabyasachi saree" }], hashtags: ["sabyasachi", "silksaree"], match_mode: "all" }) });
  });
  await page.goto("/dashboard");
  const research = page.locator(".instagram-hashtag-research");
  await research.locator("summary").click();
  await research.getByRole("button", { name: "Get Google results here" }).click();
  await expect(research.getByRole("region", { name: "Google results", exact: true }).getByRole("link", { name: "Review Instagram post ↗" })).toBeVisible();
  fail = true;
  await research.getByRole("button", { name: "Get Google results here" }).click();
  await expect(research.getByRole("alert")).toHaveText("Google search connection unavailable");
  await expect(research.getByRole("button", { name: "Get Google results here" })).toBeEnabled();
  await research.getByLabel("Hashtags to search").fill("#sabyasachi #redsaree");
  await expect(research.getByRole("region", { name: "Google results", exact: true })).toHaveCount(0);
  await expect(research.getByText("Google results: run a new search to apply the current hashtag combination.")).toBeVisible();
  await expect(research.getByRole("link").filter({ hasText: "site:instagram.com" })).toContainText('"#redsaree"');
});

test("reopening research preserves the searched combination and changing a filter hides old matches", async ({ page }) => {
  await page.route("**/cases/look/hashtags", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    ...plan, search: { status: "completed", detail: "All hashtags matched.", hashtags: ["sabyasachi", "redsaree"], match_mode: "all",
      results: [{ ...lead, caption: "Another wearer #sabyasachi #redsaree" }] },
  }) }));
  await page.goto("/dashboard");
  const research = page.locator(".instagram-hashtag-research");
  await research.locator("summary").click();
  await expect(research.getByLabel("Hashtags to search")).toHaveValue("#sabyasachi #redsaree");
  await expect(research.getByRole("link", { name: "Review Instagram post ↗" })).toBeVisible();
  await research.getByLabel("Hashtags to search").fill("#sabyasachi #silksaree");
  await expect(research.getByRole("link", { name: "Review Instagram post ↗" })).toHaveCount(0);
});
