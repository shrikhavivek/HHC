import { setTimeout as delay } from "node:timers/promises";

export async function redditSessionState(page) {
  if (page.isClosed()) throw new Error("The Reddit browser was closed");
  try {
    return await page.evaluate(() => {
      if (!["reddit.com", "www.reddit.com"].includes(location.hostname)) return "waiting";
      const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const walk = root => [...root.querySelectorAll("*")].flatMap(el => [el, ...(el.shadowRoot ? walk(el.shadowRoot) : [])]);
      const elements = walk(document);
      if (/blocked by network security|you(?:'|’)?ve been blocked|your request has been blocked/i.test(document.body?.innerText || "")) return "blocked";
      if (/^\/(login|register|account\/sso|challenge|captcha)(\/|$)/.test(location.pathname)
          || elements.some(el => el.matches('input[type="password"]') && visible(el))
          || /prove your humanity|verify you are human/i.test(document.body?.innerText || "")) return "waiting";
      const signedIn = elements.some(el => {
        if (!visible(el)) return false;
        if (el.matches('shreddit-app[logged-in]')) return ["", "true"].includes(el.getAttribute("logged-in"));
        if (el.tagName === "A") {
          const href = new URL(el.getAttribute("href") || "", location.href);
          return href.origin === location.origin && /^\/(settings|message\/inbox|logout)(\/|$)/.test(href.pathname);
        }
        return el.tagName === "BUTTON" && /^log\s*out$/i.test(el.textContent.trim());
      });
      return signedIn ? "signed_in" : "waiting";
    });
  } catch (error) {
    if (page.isClosed()) throw new Error("The Reddit browser was closed");
    if (/execution context was destroyed|cannot find context/i.test(error.message)) return "waiting";
    throw error;
  }
}

export async function waitForRedditLogin(page, {timeoutMs=15*60*1000, pollMs=2000, pause=delay, now=Date.now}={}) {
  const deadline = now() + timeoutMs;
  let reportedBlock = false;
  let checkedAccountAt = "";
  while (now() < deadline) {
    const state = await redditSessionState(page);
    if (state === "signed_in") return;
    // New Reddit layouts may hide account links in a collapsed menu. After the
    // user leaves login, check session identity in the browser without exporting it.
    const current = new URL(page.url());
    if (state === "waiting" && current.origin === "https://www.reddit.com"
        && !/^\/(login|register|account|challenge|captcha)(\/|$)/.test(current.pathname)
        && checkedAccountAt !== page.url()) {
      checkedAccountAt = page.url();
      const signedIn = await page.evaluate(async () => {
        try {
          const response = await fetch('/api/me.json', {credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(10000)});
          if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return false;
          const account = await response.json();
          return typeof account?.data?.id === 'string' && !!account.data.id;
        } catch { return false; }
      });
      if (signedIn) return;
    }
    if (state === "blocked" && !reportedBlock) {
      console.log("Reddit is restricting this browser. No posts will be scanned. You can use Reddit's sign-in or verification controls yourself; waiting for a signed-in page.");
      reportedBlock = true;
    }
    await pause(pollMs);
  }
  throw new Error("Reddit sign-in was not confirmed within 15 minutes; no screenshots were taken");
}
