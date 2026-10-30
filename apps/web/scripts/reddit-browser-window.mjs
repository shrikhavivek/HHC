import { setTimeout as delay } from "node:timers/promises";

// A failed navigation must leave the source window available to the user.
// Only the user reloads or navigates after an error; this never retries requests.
export async function navigateReddit(page, url, { ready, onWaiting, onResumed, timeoutMs = 15 * 60 * 1000, pollMs = 1500, pause = delay, now = Date.now } = {}) {
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (!response || response.status() < 400) return;
  } catch (error) {
    if (page.isClosed()) throw new Error("The Reddit window was closed.");
    // Network errors leave a browser error page that the user can refresh.
    if (!/net::|timeout|navigation|interrupted/i.test(error.message)) throw error;
  }
  await onWaiting();
  await page.bringToFront().catch(() => {});
  const deadline = now() + timeoutMs;
  while (!page.isClosed() && now() < deadline) {
    let loaded = false;
    try { loaded = await ready(); }
    catch (error) {
      if (page.isClosed()) break;
      if (!/execution context|cannot find context|navigation|target.*closed/i.test(error.message)) throw error;
    }
    if (loaded) { await onResumed(); return; }
    await pause(pollMs);
  }
  if (page.isClosed()) throw new Error("The Reddit window was closed.");
  throw new Error("Reddit did not become available within 15 minutes. Close the Reddit window and start a new collection when ready.");
}

export async function keepRedditWindowOpen(context, onWaiting) {
  if (!context || !context.pages().some(page => !page.isClosed())) return;
  // Register first so closing the window during the status update cannot hang.
  const closed = new Promise(resolve => context.once("close", resolve));
  await onWaiting();
  if (!context.pages().some(page => !page.isClosed())) return;
  await closed;
}
