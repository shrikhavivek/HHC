import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSession, SESSION_COOKIE, sessionMaxAge, sameOrigin, internalRequest, cookieOptions } from "@/lib/session";
import { editorAccount, verifyEditorPassword } from "@/lib/editor-auth";
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "Sign in from this website." }, { status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 4096) return NextResponse.json({ detail: "Request too large" }, { status: 413 });
  let username: string, password: string;
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
    username = typeof data.username === "string" ? data.username.trim() : ""; password = data.password;
    if (!username || username.length > 120 || typeof password !== "string" || !password || password.length > 256) throw new Error();
  } catch { return NextResponse.json({ detail: "Enter your username and password." }, { status: 400 }); }
  const site = (process.env.WORDPRESS_SITE_URL || "https://www.highheelconfidential.com").replace(/\/$/, "");
  try {
    const account = editorAccount();
    if (!account) throw new Error();
    // One configured editor: a fixed bucket prevents varying usernames from bypassing the limit.
    const limit = await internalRequest("login-attempt", { method: "POST", body: JSON.stringify({ key: createHash("sha256").update("studio-editor-login").digest("hex") }) });
    if (limit.status === 429) return NextResponse.json({ detail: "Too many attempts. Try again in 15 minutes." }, { status: 429, headers: { "Retry-After": "900" } });
    if (!limit.ok) throw new Error();
    const validPassword = await verifyEditorPassword(password, account.hash);
    if (!validPassword || username.toLowerCase() !== account.username.toLowerCase()) return NextResponse.json({ detail: "Incorrect username or password." }, { status: 401 });
    const session = { id: randomBytes(32).toString("hex"), username: account.username, site, demo: false, studio: true, authVersion: account.version, exp: Math.floor(Date.now() / 1000) + sessionMaxAge };
    const registered = await internalRequest("sessions", { method: "POST", body: JSON.stringify({ id: session.id, actor: session.username, expires_at: session.exp }) });
    if (!registered.ok) throw new Error();
    const result = NextResponse.json({ ok: true, username: session.username }, { headers: { "Cache-Control": "no-store" } });
    result.cookies.set(SESSION_COOKIE, createSession(session), cookieOptions());
    return result;
  } catch { return NextResponse.json({ detail: "Sign-in is temporarily unavailable. Please try again." }, { status: 503 }); }
}
