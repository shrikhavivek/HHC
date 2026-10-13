import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const profileDirectory = join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "HHC", "instagram-browser-profile");
await mkdir(profileDirectory, { recursive: true });

const context = await chromium.launchPersistentContext(profileDirectory, {
  channel: "msedge",
  headless: false,
  viewport: null,
  acceptDownloads: false,
});
const page = context.pages()[0] || await context.newPage();
const terminal = createInterface({ input: process.stdin, output: process.stdout });
let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  terminal.close();
  await context.close();
}

context.on("close", () => terminal.close());
process.on("SIGINT", () => { void close(); });
const timeout = setTimeout(() => { void close(); }, 30 * 60 * 1000);
timeout.unref();

try {
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
} catch {
  console.log("Instagram did not finish loading. You can navigate in the browser yourself.");
}

console.log("Sign in yourself in the separate Edge window. Do not enter passwords in this terminal or chat.");
console.log("The local profile retains your session outside the repository. No cookies or passwords are exported.");
console.log("Commands: open <public-handle>, post <shortcode>, check, inspect, close. Read-only checks; no scrolling or background scanning.");
console.log("The browser closes after 30 minutes. Close sooner with the close command or the browser window.");

try {
  for await (const input of terminal) {
    const command = input.trim();
    if (command === "close") break;
    if (command.startsWith("open ") || command.startsWith("post ")) {
      const post = command.startsWith("post ");
      const handle = command.slice(5).trim().replace(/^@/, "");
      if (!(post ? /^[A-Za-z0-9_-]{1,32}$/ : /^[A-Za-z0-9._]{1,30}$/).test(handle)) {
        console.log("Enter a valid Instagram handle or post shortcode, not a URL or password.");
        continue;
      }
      try {
        await page.goto(`https://www.instagram.com/${post ? "p/" : ""}${handle}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
        console.log("Page opened. Wait for it to load, then use check for profile links or inspect for post details. Complete any sign-in or verification yourself.");
      } catch {
        console.log("Profile could not be loaded. No retry was attempted.");
      }
      continue;
    }
    if (command !== "check" && command !== "inspect") {
      console.log("Available commands: open <public-handle>, post <shortcode>, check, inspect, close.");
      continue;
    }
    try {
      const current = new URL(page.url());
      if (current.hostname !== "www.instagram.com" && current.hostname !== "instagram.com") {
        console.log("Check stopped: open an Instagram profile first.");
        continue;
      }
      if (/\/(accounts|challenge|checkpoint)\//.test(current.pathname) || await page.locator('input[type="password"], form[action*="challenge"], form[action*="captcha"]').count()) {
        console.log("Check stopped: sign-in or verification is required. Complete it yourself in the browser.");
        continue;
      }
      const blocked = await page.getByText(/try again later|we restrict certain activity|automated behavior|confirm you're human|unusual activity/i).count();
      if (blocked) {
        console.log("Check stopped: Instagram displayed an access restriction. No retry or bypass was attempted.");
        continue;
      }
      if (command === "inspect") {
        if (!/^\/(?:[A-Za-z0-9._]+\/)?p\/[A-Za-z0-9_-]+\/?$/.test(current.pathname)) {
          console.log("Inspection stopped: open an individual photo post first.");
          continue;
        }
        const details = await page.evaluate(() => {
          const visible = element => element.getClientRects().length > 0;
          const root = document.querySelector("main") || document.querySelector("article");
          if (!root) return { available: false };
          return {
            title: document.title,
            description: document.querySelector('meta[property="og:description"]')?.getAttribute("content") || "",
            dates: [...root.querySelectorAll("time[datetime]")].filter(visible).map(element => ({ datetime: element.getAttribute("datetime"), permalink: element.closest("a")?.href || "" })),
            visible_video: [...root.querySelectorAll("video")].some(visible),
            visible_images: [...root.querySelectorAll("img")].filter(element => visible(element) && element.naturalWidth >= 300 && element.naturalHeight >= 300).slice(0, 10).map(element => ({ alt: element.alt, width: element.naturalWidth, height: element.naturalHeight })),
          };
        });
        console.log(JSON.stringify({ permalink: current.origin + current.pathname, ...details, note: "Read-only inspection; no images imported. Verify dates belong to this permalink, not comments or suggested posts." }, null, 2));
        continue;
      }
      const links = await page.locator('a[href*="/p/"]').evaluateAll(anchors => [...new Set(anchors.filter(anchor => anchor.getClientRects().length).map(anchor => anchor.href))].filter(link => {
        const target = new URL(link);
        return ["www.instagram.com", "instagram.com"].includes(target.hostname) && /^\/(?:[A-Za-z0-9._]+\/)?p\/[A-Za-z0-9_-]+\/?$/.test(target.pathname);
      }).slice(0, 12));
      console.log(JSON.stringify({ visible_post_links: links, note: "Links only. Publication dates, photo/video types and image access still need verification. Reel links are excluded; /p/ links may still contain videos." }, null, 2));
    } catch {
      console.log("Check could not complete. No automatic retry was attempted.");
    }
  }
} finally {
  clearTimeout(timeout);
  await close();
}
