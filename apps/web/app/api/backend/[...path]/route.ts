import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: Context) {
  const session = verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ detail: "WordPress authentication required" }, { status: 401 });
  const { path } = await context.params;
  const base = process.env.API_INTERNAL_URL || "http://localhost:8000";
  const target = new URL(`/api/${path.join("/")}`, base);
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  const headers: HeadersInit = { "X-Editor-Key": process.env.EDITOR_API_KEY || "local-editor-key" };
  const contentType = request.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  // Preserve multipart boundaries and binary image bytes for collage uploads.
  // Reading a multipart request as text corrupts JPEG/WebP payloads.
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  const response = await fetch(target, { method: request.method, headers, body, cache: "no-store" });
  const data = await response.arrayBuffer();
  return new NextResponse(data, { status: response.status, headers: { "Content-Type": response.headers.get("content-type") || "application/json" } });
}

export const GET = proxy;
export const POST = proxy;
