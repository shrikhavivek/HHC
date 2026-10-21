import { test, expect } from "@playwright/test";
import { instagramSessionState, waitForInstagramLogin, InstagramAccessBlocked, InstagramLoginCancelled, InstagramIntakePaused } from "./scripts/instagram-login.mjs";

async function instagramFixture(page) {
  await page.route("https://www.instagram.com/**", route => {
    const path = new URL(route.request().url()).pathname;
    const content = path === "/" ? '<nav><a href="/direct/inbox/">Messages</a></nav>'
      : path.startsWith("/accounts/") ? '<form><input name="username"><input type="password"><button>Log in</button></form>'
      : path.startsWith("/challenge/") ? '<form action="/challenge/">Enter your verification code<input name="code"></form>'
      : path === "/restricted/" ? '<div role="alert">We restrict certain activity. Try again later.</div>'
      : '<main>Public profile<img alt="Public post"><a href="/direct/inbox/" hidden>Hidden navigation</a></main>';
    return route.fulfill({ contentType: "text/html", body: content });
  });
}

test("waits through login and verification, then continues without another scan click", async ({ page }) => {
  await instagramFixture(page);
  await page.goto("https://www.instagram.com/accounts/login/");
  let waiting = 0;
  let resumed = false;
  const result = waitForInstagramLogin(page, { pollMs: 20, onWaiting: async () => { waiting++; } }).then(() => { resumed = true; });
  await expect.poll(() => waiting).toBeGreaterThan(0);
  expect(resumed).toBe(false);
  await expect(page.locator('input[type="password"]')).toHaveValue("");
  await page.goto("https://www.instagram.com/challenge/code/");
  expect(await instagramSessionState(page)).toBe("waiting");
  expect(resumed).toBe(false);
  // Represents the user's successful login; no password is entered by the collector.
  await page.goto("https://www.instagram.com/");
  await result;
  expect(resumed).toBe(true);
});

test("an existing signed-in session proceeds immediately", async ({ page }) => {
  await instagramFixture(page);
  await page.goto("https://www.instagram.com/");
  await waitForInstagramLogin(page, { pause: async () => { throw new Error("Should not wait when signed in"); } });
});

test("public profiles cannot start a scan; waiting refreshes the heartbeat and times out", async ({ page }) => {
  await instagramFixture(page);
  await page.goto("https://www.instagram.com/publicperson/");
  expect(await instagramSessionState(page)).toBe("waiting");
  let now = 0;
  let heartbeats = 0;
  await expect(waitForInstagramLogin(page, {
    timeoutMs: 12000, now: () => now, pollMs: 6000,
    pause: async ms => { now += ms; }, onWaiting: async () => { heartbeats++; },
  })).rejects.toBeInstanceOf(InstagramLoginCancelled);
  expect(heartbeats).toBe(2);
});

test("closing Instagram cancels the wait", async ({ page }) => {
  await instagramFixture(page);
  await page.goto("https://www.instagram.com/accounts/login/");
  let waiting = false;
  const result = waitForInstagramLogin(page, { pollMs: 20, onWaiting: async () => { waiting = true; } }).catch(error => error);
  await expect.poll(() => waiting).toBe(true);
  await page.close();
  expect(await result).toBeInstanceOf(InstagramLoginCancelled);
});

test("restrictions stop collection and paused intake cancels login", async ({ page }) => {
  await instagramFixture(page);
  await page.goto("https://www.instagram.com/restricted/");
  await expect(waitForInstagramLogin(page)).rejects.toBeInstanceOf(InstagramAccessBlocked);
  await page.goto("https://www.instagram.com/accounts/login/");
  await expect(waitForInstagramLogin(page, { isEnabled: async () => false })).rejects.toBeInstanceOf(InstagramIntakePaused);
});

test("Scan now shows login instructions and then scan progress without a second click", async ({ page }) => {
  await page.clock.install();
  let state = "not_run";
  let scanRequests = 0;
  const report = () => ({ status: state, heartbeat: Date.now() / 1000, runner_online: true, current_account: "Alia Bhatt", accounts_total: 121 });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data = {};
    if (path === "/api/auth/session") data = { username: "editor", demo: true };
    else if (path.endsWith("/dashboard")) data = { total: 0, status_counts: {}, source_mode: "rss" };
    else if (path === "/api/backend/cases") data = [];
    else if (path.endsWith("/operations")) data = { runs: [] };
    else if (path.endsWith("/instagram-browser/config")) data = { enabled: true, celebrities: [{ name: "Alia Bhatt", handle: "aliaabhatt", enabled: true }], brands: [] };
    else if (path.endsWith("/instagram-browser/posts")) data = { results: [] };
    else if (path.endsWith("/instagram-browser/status")) data = report();
    else if (path.endsWith("/instagram-browser/scan")) { scanRequests++; state = "awaiting_login"; data = report(); }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto("/dashboard");
  const panel = page.getByRole("region", { name: "Instagram discovery" });
  await panel.getByRole("button", { name: "Scan now", exact: true }).click();
  await expect(panel.getByText("Waiting for Instagram sign-in", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Waiting for sign-in…" })).toBeDisabled();
  await expect(panel.getByText(/Complete sign-in or verification/)).toBeVisible();
  state = "running";
  await page.clock.runFor(5100);
  await expect(panel.getByText("Scanning Alia Bhatt", { exact: true })).toBeVisible();
  expect(scanRequests).toBe(1);
  state = "cancelled";
  await page.clock.runFor(5100);
  await expect(panel.getByRole("button", { name: "Scan now", exact: true })).toBeEnabled();
});
