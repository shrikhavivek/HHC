import { test, expect } from "@playwright/test";
import { waitForRedditLogin } from "./scripts/reddit-login.mjs";
import { navigateReddit, keepRedditWindowOpen } from "./scripts/reddit-browser-window.mjs";

for (const provider of ["instagram", "reddit"]) {
  test(`${provider} sign-in button queues collection, waits for login and reports completion`, async ({ page }) => {
    test.skip(!process.env.HHC_TEST_USERNAME || !process.env.HHC_TEST_PASSWORD, "Supply credentials for the local test installation");
    const base = process.env.HHC_TEST_BASE_URL || "http://localhost:3200";
    const response = await page.request.post(`${base}/api/auth/login`, { headers: { Origin: base }, data: { username: process.env.HHC_TEST_USERNAME, password: process.env.HHC_TEST_PASSWORD } });
    expect(response.ok()).toBeTruthy();
    let status = provider === "reddit"
      ? { status: "failed", runner_online: true, updated_at: "2026-10-26T12:08:44Z", detail: 'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE\nCall log:\n\u001b[2m - navigating to Reddit\u001b[22m' }
      : { status: "not_run", runner_online: true };
    let requests = 0;
    await page.route(`**/api/backend/${provider}-browser/status`, route => route.fulfill({ json: status }));
    await page.route(`**/api/backend/${provider}-browser/scan`, route => {
      requests++;
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({});
      status = { status: "awaiting_login", runner_online: true, run_id: "ui-fixture", heartbeat: Date.now() / 1000, detail: "Sign in in the source window." };
      return route.fulfill({ status: 202, json: status });
    });
    await page.goto("/dashboard");
    const name = provider === "reddit" ? "Reddit" : "Instagram";
    const card = page.getByRole("article", { name: `${name} browser intake` });
    const button = card.getByRole("button");
    await expect(button).toHaveText(new RegExp(`Sign in to ${name}`));
    if (provider === "reddit") {
      await expect(card.getByText("Last attempt failed", { exact: true })).toBeVisible();
      await expect(card.getByText(/The previous attempt could not load Reddit/)).toBeVisible();
      await expect(card.getByText(/Last attempt:.*26 Oct/)).toBeVisible();
      await expect(card).not.toContainText("Call log:");
      await expect(card).not.toContainText("net::ERR_");
    }
    await button.click();
    await expect(button).toHaveText(new RegExp(`Waiting for ${name} sign-in`));
    await expect(button).toBeDisabled();
    expect(requests).toBe(1);
    if (provider === "reddit") {
      status = { ...status, status: "awaiting_attention", detail: "Reddit could not load. Refresh the open Reddit window." };
      await expect(button).toHaveText(/Check the Reddit window/, { timeout: 10000 });
      await expect(button).toBeDisabled();
      await expect(card.getByText("Needs your attention")).toBeVisible();
    }
    status = { ...status, status: "running", posts_checked: 2, detail: "Capturing photos." };
    await expect(button).toHaveText(new RegExp(`Collecting ${name} photos`), { timeout: 10000 });
    status = { ...status, status: "completed", imported: 1, detail: "One recent photo post collected." };
    await expect(card.getByText("One recent photo post collected.")).toBeVisible({ timeout: 10000 });
    await expect(button).toBeEnabled();
    await expect(card.getByText("2 posts checked · 1 posts collected")).toBeVisible();
    status = { ...status, status: "partial", coverage: {
      window_start: "2026-10-25", window_end: "2026-10-26", as_of: "2026-10-26T12:00:00Z",
      targets: [{ target: "coverage-fixture", status: "partial", checked: 150, qualifying: 7, collected: 1, existing: 6, failures: 2, stop_reason: "feed_stalled" }],
    } };
    await expect(card.getByText("Partly collected", { exact: true })).toBeVisible({ timeout: 10000 });
    const coverage = card.locator("details");
    await expect(coverage.locator("summary")).toHaveText("Coverage: 0 / 1 sources checked through yesterday");
    await coverage.locator("summary").click();
    await expect(coverage).toContainText("150 checked");
    await expect(coverage).toContainText("The source stopped loading more posts");
    await expect(coverage).toContainText("2 unresolved posts");
  });
}

test("Reddit waits for website sign-in and resumes automatically", async ({ page }) => {
  await page.route("https://www.reddit.com/**", route => route.fulfill({ contentType: "text/html", body: new URL(route.request().url()).pathname.startsWith("/login") ? '<input type="password">' : '<a href="/settings/">Settings</a>' }));
  await page.goto("https://www.reddit.com/login/");
  let resumed = false;
  const waiting = waitForRedditLogin(page, { pollMs: 20 }).then(() => { resumed = true; });
  await expect(page.locator('input[type="password"]')).toHaveValue("");
  expect(resumed).toBe(false);
  await page.goto("https://www.reddit.com/");
  await waiting;
  expect(resumed).toBe(true);
});

test("a failed Reddit navigation keeps the window open and resumes only after the user loads the page", async ({ page }) => {
  let fail = true;
  let requests = 0;
  let waiting = false;
  let resumed = false;
  const url = "https://www.reddit.com/login/";
  await page.route("https://www.reddit.com/**", route => {
    requests++;
    return fail ? route.abort("failed") : route.fulfill({ contentType: "text/html", body: '<a href="/settings/">Settings</a>' });
  });
  const navigation = navigateReddit(page, url, {
    ready: async () => await page.getByText("Settings", { exact: true }).count() > 0,
    onWaiting: async () => { waiting = true; }, onResumed: async () => { resumed = true; }, pollMs: 20,
  });
  await expect.poll(() => waiting).toBe(true);
  expect(page.isClosed()).toBe(false);
  expect(requests).toBe(1);
  expect(resumed).toBe(false);
  fail = false;
  await page.goto(url); // The user's refresh, not an automated retry.
  await navigation;
  expect(resumed).toBe(true);
  expect(page.isClosed()).toBe(false);
  expect(requests).toBe(2);
});

test("a Reddit error window remains open until the user closes it", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let reported = false;
  let finished = false;
  const waiting = keepRedditWindowOpen(context, async () => { reported = true; }).then(() => { finished = true; });
  await expect.poll(() => reported).toBe(true);
  expect(page.isClosed()).toBe(false);
  expect(finished).toBe(false);
  await context.close();
  await waiting;
  expect(finished).toBe(true);
});

test("a failed navigation timeout leaves Reddit open for inspection", async ({ page }) => {
  await page.route("https://www.reddit.com/**", route => route.fulfill({ status: 503, contentType: "text/html", body: "Unavailable" }));
  let now = 0;
  await expect(navigateReddit(page, "https://www.reddit.com/login/", {
    ready: async () => false, onWaiting: async () => {}, onResumed: async () => { throw new Error("Must not resume"); },
    timeoutMs: 100, pollMs: 100, now: () => now, pause: async ms => { now += ms; },
  })).rejects.toThrow(/did not become available/);
  expect(page.isClosed()).toBe(false);
});
