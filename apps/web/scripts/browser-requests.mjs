import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function pollProvider(provider, api, launch, running) {
  await api(provider, "/heartbeat", {});
  if (running.has(provider)) return;
  const status = await api(provider, "/status");
  const age = Date.now() / 1000 - (status.heartbeat || 0);
  if (status.status !== "queued" || age < 0 || age >= 180) return;
  running.add(provider);
  // Keep both sources' heartbeats alive while either browser is waiting for sign-in.
  Promise.resolve().then(() => launch(provider)).catch(() => {}).finally(() => running.delete(provider));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { request } = await import("./browser-local-api.mjs");
  const children = new Map();
  const running = new Set();
  let stopping = false;
  const launch = provider => new Promise((done, reject) => {
    const script = provider === "instagram" ? "instagram-daily.mjs" : "reddit-browser.mjs";
    const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), "--queued"], { windowsHide: true, stdio: "ignore" });
    children.set(provider, child);
    child.once("error", error => { children.delete(provider); reject(error); });
    child.once("close", () => { children.delete(provider); done(); });
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    stopping = true;
    for (const child of children.values()) child.kill();
  });
  while (!stopping) {
    await Promise.allSettled(["instagram", "reddit"].map(provider => pollProvider(provider, request, launch, running)));
    if (!stopping) await delay(3000);
  }
}
