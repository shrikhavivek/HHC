// Hosted requests are capped at 4.5 MB: photos go straight to storage and the
// form carries their keys. A local API answers "inline" and gets the files.
export async function stagePhotos(form, apiRoot, headers) {
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

// HHC_API_URL points a collector at a hosted API instead of the local one.
export function apiRootFrom(environment) {
  return (process.env.HHC_API_URL || environment.HHC_API_URL || "http://127.0.0.1:8100").replace(/\/$/, "");
}
