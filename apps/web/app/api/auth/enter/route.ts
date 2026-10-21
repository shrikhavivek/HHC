import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { authenticatedSession, cookieOptions, createSession, internalRequest, sameOrigin, SESSION_COOKIE, sessionMaxAge } from "@/lib/session";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "Open the studio from this website." }, { status: 403 });
  // The password-free entrance is for the existing loopback Docker deployment.
  if (process.env.APP_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.APP_ORIGIN || request.nextUrl.origin).hostname)) {
    return NextResponse.json({ detail: "The open studio entrance is available in the local app." }, { status: 403 });
  }
  try {
    if (await authenticatedSession(request)) return NextResponse.json({ ok: true });
    const session = { id: randomBytes(32).toString("hex"), username: "Local editor", site: process.env.WORDPRESS_SITE_URL || "https://www.highheelconfidential.com", demo: false, studio: true, exp: Math.floor(Date.now() / 1000) + sessionMaxAge };
    const registered = await internalRequest("sessions", { method: "POST", body: JSON.stringify({ id: session.id, actor: session.username, expires_at: session.exp }) });
    if (!registered.ok) throw new Error();
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, createSession(session), cookieOptions());
    return response;
  } catch { return NextResponse.json({ detail: "The studio could not be reached. Please try again." }, { status: 503 }); }
}
