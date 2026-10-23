// Hosted (serverless) requests are capped at 4.5 MB, so with Supabase storage
// the file goes straight to the bucket and the form carries only its key.
// Locally the API answers "inline" and the form is sent unchanged.
export async function stageFormFile(form: FormData, field = "image"): Promise<FormData> {
  const file = form.get(field);
  if (!(file instanceof File) || !file.size) return form;
  const response = await fetch("/api/backend/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 1 }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Could not prepare the upload.");
  if (data.mode !== "direct") return form;
  const [target] = data.uploads as { key: string; url: string }[];
  const upload = await fetch(target.url, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" }, body: file });
  if (!upload.ok) throw new Error("The image could not be uploaded to storage.");
  const staged = new FormData();
  for (const [name, value] of form.entries()) if (name !== field) staged.append(name, value);
  staged.set("upload_keys", JSON.stringify([target.key]));
  staged.set("upload_names", JSON.stringify([file.name]));
  return staged;
}
