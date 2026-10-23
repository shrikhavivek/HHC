import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

let environment = {};
try { environment = parseEnv(await readFile(fileURLToPath(new URL("../../../.env", import.meta.url)), "utf8")); } catch {}
const apiKey = process.env.EDITOR_API_KEY || environment.EDITOR_API_KEY || (environment.APP_ENV === "production" ? "" : "local-editor-key");
if (!apiKey) throw new Error("Configure the local API editor key before starting the collector.");
// HHC_API_URL points the collector at a hosted API instead of the local one.
const apiRoot = (process.env.HHC_API_URL || environment.HHC_API_URL || "http://127.0.0.1:8100").replace(/\/$/, "");
const api = `${apiRoot}/api/instagram-browser`;
const headers = { "X-Editor-Key": apiKey, "X-Editor-Id": "local-instagram-browser" };

// Hosted requests are capped at 4.5 MB: photos go straight to storage and the
// form carries their keys. A local API answers "inline" and gets the files.
async function stagePhotos(form) {
  const photos = [...form.getAll("image"), ...form.getAll("images")].filter(value => value instanceof Blob);
  if (!photos.length) return form;
  const linkResponse = await fetch(`${apiRoot}/api/uploads`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ count: photos.length }), redirect: "error", signal: AbortSignal.timeout(30000) });
  const links = await linkResponse.json();
  if (!linkResponse.ok) throw new Error(`Local API ${linkResponse.status}: ${typeof links.detail === "string" ? links.detail : "upload links rejected"}`);
  if (links.mode !== "direct") return form;
  for (const [index, photo] of photos.entries()) {
    const upload = await fetch(links.uploads[index].url, { method: "PUT", headers: { "Content-Type": photo.type || "image/jpeg" }, body: photo, signal: AbortSignal.timeout(120000) });
    if (!upload.ok) throw new Error(`Local API ${upload.status}: photo upload to storage failed`);
  }
  const staged = new FormData();
  for (const [name, value] of form.entries()) if (name !== "image" && name !== "images") staged.append(name, value);
  staged.set("upload_keys", JSON.stringify(links.uploads.map(item => item.key)));
  return staged;
}

export async function request(path, body, form = false) {
  if (form) body = await stagePhotos(body);
  const response = await fetch(api + path, { method: body ? "POST" : "GET", headers: { ...headers, ...(body && !form ? { "Content-Type": "application/json" } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(120000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Local API ${response.status}: ${typeof data.detail === "string" ? data.detail : "request rejected"}`);
  return data;
}
