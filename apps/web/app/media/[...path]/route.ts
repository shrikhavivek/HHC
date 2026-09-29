import { NextRequest, NextResponse } from "next/server";

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
  const { path } = await context.params;
  if (!path.length || !["static", "outputs", "media-files"].includes(path[0]) || path.some(part => !part || part === "." || part === "..")) {
    return NextResponse.json({ detail: "Media path not allowed" }, { status: 404 });
  }

  const base = process.env.API_INTERNAL_URL || "http://localhost:8000";
  const target = new URL(`/${path.map(encodeURIComponent).join("/")}`, base);
  let response: Response;
  try {
    response = await fetch(target, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  } catch {
    return NextResponse.json({ detail: "Media service unavailable" }, { status: 502 });
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
      "Cache-Control": ["static", "media-files"].includes(path[0]) ? "public, max-age=3600" : "no-store",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
