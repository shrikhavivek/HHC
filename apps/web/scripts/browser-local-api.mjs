import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const environment = parseEnv(await readFile(process.env.HHC_ENV_FILE || fileURLToPath(new URL("../../../.env", import.meta.url)), "utf8"));
const key = process.env.EDITOR_API_KEY || environment.EDITOR_API_KEY;
if (!key) throw new Error("Configure the local editor API key before starting the browser collector.");

export async function request(provider, path, body) {
  if (!["instagram", "reddit"].includes(provider)) throw new Error("Unsupported source");
  const form = body instanceof FormData;
  const response = await fetch(`http://127.0.0.1:8100/api/${provider}-browser${path}`, {
    method: body ? "POST" : "GET", redirect: "error",
    headers: { "X-Editor-Key": key, "X-Editor-Id": `local-${provider}-browser`, ...(body && !form ? { "Content-Type": "application/json" } : {}) },
    body: body ? form ? body : JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Local collector request failed (${response.status})`);
  return data;
}
