import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

let environment = {};
try { environment = parseEnv(await readFile(fileURLToPath(new URL("../../../.env", import.meta.url)), "utf8")); } catch {}
const apiKey = process.env.EDITOR_API_KEY || environment.EDITOR_API_KEY || (environment.APP_ENV === "production" ? "" : "local-editor-key");
if (!apiKey) throw new Error("Configure the local API editor key before starting the collector.");
const api = "http://127.0.0.1:8100/api/instagram-browser";

export async function request(path, body, form = false) {
  const response = await fetch(api + path, { method: body ? "POST" : "GET", headers: { "X-Editor-Key": apiKey, "X-Editor-Id": "local-instagram-browser", ...(body && !form ? { "Content-Type": "application/json" } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(120000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Local API ${response.status}: ${typeof data.detail === "string" ? data.detail : "request rejected"}`);
  return data;
}
