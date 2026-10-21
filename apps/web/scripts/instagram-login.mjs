import { setTimeout as delay } from "node:timers/promises";

export class InstagramAccessBlocked extends Error {}
export class InstagramLoginCancelled extends Error {}
export class InstagramIntakePaused extends Error {}

// Inspect only visible page controls. Credentials and cookies stay in Edge.
export async function instagramSessionState(page) {
  if (page.isClosed()) throw new InstagramLoginCancelled("Instagram was closed. Choose Scan now to open it again.");
  try {
    return await page.evaluate(() => {
      if (!["www.instagram.com", "instagram.com"].includes(location.hostname)) return "waiting";
      const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
      if (/try again later|we restrict certain activity|automated behavior|unusual activity/i.test(document.body?.innerText || "")) return "blocked";
      if (/^\/(accounts|challenge|checkpoint)\//.test(location.pathname)
          || [...document.querySelectorAll('input[type="password"], form[action*="challenge"], form[action*="captcha"]')].some(visible)) return "waiting";
      // Public profiles can render without a login. Require authenticated navigation.
      return [...document.querySelectorAll('a[href^="/direct/"], a[href^="/accounts/edit"], a[href="https://www.instagram.com/direct/inbox/"]')].some(visible) ? "signed_in" : "waiting";
    });
  } catch (error) {
    if (page.isClosed()) throw new InstagramLoginCancelled("Instagram was closed. Choose Scan now to open it again.");
    // A user completing sign-in can replace the page's execution context.
    if (/execution context was destroyed|cannot find context/i.test(error.message)) return "waiting";
    throw error;
  }
}

export async function waitForInstagramLogin(page, {
  onWaiting = async () => {}, isEnabled = async () => true,
  timeoutMs = 15 * 60 * 1000, pollMs = 2000, now = Date.now, pause = delay,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastHeartbeat = -Infinity;
  while (now() < deadline) {
    if (now() - lastHeartbeat >= 5000) {
      if (!await isEnabled()) throw new InstagramIntakePaused("Instagram intake was paused in Watchlist settings.");
      await onWaiting();
      lastHeartbeat = now();
    }
    const state = await instagramSessionState(page);
    if (state === "blocked") throw new InstagramAccessBlocked("Instagram has restricted access. Resolve the restriction in Instagram before starting another scan.");
    if (state === "signed_in") return;
    await pause(pollMs);
  }
  throw new InstagramLoginCancelled("Sign-in timed out after 15 minutes. Choose Scan now when you are ready to sign in.");
}
