import { NextRequest, NextResponse } from "next/server";
import { authenticatedSession, sameOrigin } from "@/lib/session";
type Context = { params: Promise<{ path: string[] }> };
async function proxy(request: NextRequest, context: Context) {
  if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request)) return NextResponse.json({ detail: "Invalid origin" }, { status: 403 });
  const session = await authenticatedSession(request);
  if (!session) return NextResponse.json({ detail: "Please sign in again." }, { status: 401 });
  const { path } = await context.params;
  if (!path.length || path[0] === "internal" || path.some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) return NextResponse.json({ detail: "Route unavailable" }, { status: 404 });
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}`, process.env.API_INTERNAL_URL || "http://localhost:8100");
  target.search = request.nextUrl.search;
  const headers: Record<string, string> = { "X-Editor-Key": process.env.EDITOR_API_KEY || "local-editor-key", "X-Editor-Id": encodeURIComponent(session.username) };
  if (request.headers.get("content-type")) headers["Content-Type"] = request.headers.get("content-type")!;
  if (path.includes("wordpress") && session.authorization && !session.demo) headers["X-WP-Authorization"] = session.authorization;
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    if (request.body) {
      const reader = request.body.getReader();
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 24 * 1024 * 1024) { await reader.cancel(); return NextResponse.json({ detail: "Upload must be under 24 MB." }, { status: 413 }); } chunks.push(value); }
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await fetch(target, { method: request.method, headers, body, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(180000) });
    const location = response.headers.get("location");
    // Large downloads (evidence ZIPs) come from hosted storage via a signed link.
    if (response.status >= 300 && response.status < 400 && location?.startsWith("https://")) return NextResponse.redirect(location, 307);
    const responseHeaders: Record<string, string> = { "Content-Type": response.headers.get("content-type") || "application/json", "Cache-Control": "private, no-store" };
    for (const name of ["content-disposition", "retry-after"]) if (response.headers.get(name)) responseHeaders[name] = response.headers.get(name)!;
    return new NextResponse(response.body, { status: response.status, headers: responseHeaders });
  } catch { return NextResponse.json({ detail: "The service could not complete this request. Refresh its status before retrying." }, { status: 502 }); }
}
export const GET = proxy;
export const POST = proxy;
