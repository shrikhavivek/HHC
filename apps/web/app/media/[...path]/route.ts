import { NextRequest, NextResponse } from "next/server";
import { authenticatedSession } from "@/lib/session";

type Context = { params: Promise<{ path: string[] }> };

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export async function GET(_request: NextRequest, context: Context) {
  if (!await authenticatedSession(_request)) return NextResponse.json({ detail: "Sign in to view this image" }, { status: 401 });
  const { path } = await context.params;
  if (!path.length || !["static", "outputs", "media-files"].includes(path[0]) || path.some(part => !part || part === "." || part === "..")) {
    return NextResponse.json({ detail: "Media path not allowed" }, { status: 404 });
  }

  const base = process.env.API_INTERNAL_URL || "http://localhost:8000";
  const target = new URL(`/${path.map(encodeURIComponent).join("/")}`, base);
  let response: Response;
  try {
    response = await fetch(target, { headers: { "X-Editor-Key": process.env.EDITOR_API_KEY || "local-editor-key" }, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15000) });
  } catch {
    return NextResponse.json({ detail: "Media service unavailable" }, { status: 502 });
  }
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location?.startsWith("https://")) {
    // Hosted storage: the browser loads the file from a short-lived signed link.
    // Reusing the redirect for a while lets the browser cache the image itself.
    return new NextResponse(null, { status: 307, headers: { Location: location, "Cache-Control": "private, max-age=1800", "Referrer-Policy": "no-referrer" } });
  }
  if (!response.ok || !response.body) {
    return NextResponse.json({ detail: "Image not found" }, { status: response.status });
  }

  const filename = path[path.length - 1].toLowerCase();
  const extension = Object.keys(CONTENT_TYPES).find(item => filename.endsWith(item));
  const contentType = extension ? CONTENT_TYPES[extension] : response.headers.get("content-type") || "application/octet-stream";
  return new NextResponse(response.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
