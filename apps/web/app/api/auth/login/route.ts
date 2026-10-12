import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSession, SESSION_COOKIE, sessionMaxAge, sameOrigin, internalRequest, cookieOptions } from "@/lib/session";
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "Sign in from this website." }, { status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 4096) return NextResponse.json({ detail: "Request too large" }, { status: 413 });
  let username: string, applicationPassword: string;
  try {
    const chunks: Uint8Array[] = [];
    const reader = request.body?.getReader();
    let size = 0;
    if (reader) while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 4096) { await reader.cancel(); throw new Error(); }
      chunks.push(chunk.value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const data = JSON.parse(body);
    username = data.username?.trim(); applicationPassword = data.applicationPassword;
    if (!username || username.length > 120 || username.includes(":") || typeof applicationPassword !== "string" || !applicationPassword || applicationPassword.length > 256) throw new Error();
  } catch { return NextResponse.json({ detail: "Enter a valid username and application password." }, { status: 400 }); }
  const site = (process.env.WORDPRESS_SITE_URL || "https://www.highheelconfidential.com").replace(/\/$/, "");
  const demo = process.env.APP_ENV !== "production" && process.env.DEMO_LOGIN_ENABLED === "true" && username === process.env.DEMO_USERNAME;
  try {
    const limit = await internalRequest("login-attempt", { method: "POST", body: JSON.stringify({ key: createHash("sha256").update(username.toLowerCase()).digest("hex") }) });
    if (!limit.ok) return NextResponse.json({ detail: "Too many attempts. Try again in 15 minutes." }, { status: 429, headers: { "Retry-After": "900" } });
    let authorization: string | undefined;
    if (demo) {
      const received = createHash("sha256").update(applicationPassword).digest();
      const expected = createHash("sha256").update(process.env.DEMO_PASSWORD || randomBytes(32).toString("hex")).digest();
      if (!timingSafeEqual(received, expected)) return NextResponse.json({ detail: "Invalid credentials." }, { status: 401 });
    } else {
      const url = new URL(site);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
      authorization = `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString("base64")}`;
      const response = await fetch(`${site}/wp-json/wp/v2/users/me?context=edit`, { headers: { Authorization: authorization }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!response.ok) return NextResponse.json({ detail: "WordPress rejected these credentials. Use a WordPress Application Password." }, { status: 401 });
      const user = await response.json();
      if (!user.capabilities?.edit_posts || !user.capabilities?.upload_files) return NextResponse.json({ detail: "Your account needs permission to edit posts and upload media." }, { status: 403 });
    }
    const session = { id: randomBytes(32).toString("hex"), username, site, demo, authorization, exp: Math.floor(Date.now() / 1000) + sessionMaxAge };
    const registered = await internalRequest("sessions", { method: "POST", body: JSON.stringify({ id: session.id, actor: username, expires_at: session.exp }) });
    if (!registered.ok) throw new Error();
    const result = NextResponse.json({ ok: true, username, demo });
    result.cookies.set(SESSION_COOKIE, createSession(session), cookieOptions());
    return result;
  } catch { return NextResponse.json({ detail: "Sign-in is temporarily unavailable. Please try again." }, { status: 503 }); }
}
