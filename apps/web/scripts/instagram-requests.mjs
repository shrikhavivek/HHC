import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "./instagram-local-api.mjs";

// Idle polling never creates a process or window.
export async function pollForScan(api = request, launch = launchCollector) {
  await api("/heartbeat", {});
  const status = await api("/status");
  if (status.status === "queued" && Date.now() / 1000 - status.heartbeat < 180) await launch();
}

let child;
async function launchCollector() {
  const collector = fileURLToPath(new URL("./instagram-daily.mjs", import.meta.url));
  await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [collector, "--queued"], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", resolve);
  });
  child = undefined;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    stopping = true;
    child?.kill();
  });
  while (!stopping) {
    try { await pollForScan(); } catch { /* The local app may be starting or offline. */ }
    if (!stopping) await delay(3000);
  }
}
