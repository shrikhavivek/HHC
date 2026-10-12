import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession, sameOrigin, internalRequest, cookieOptions } from "@/lib/session";
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "Invalid origin" }, { status: 403 });
  const session = verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) {
    try {
      const revoked = await internalRequest(`sessions/${session.id}`, { method: "DELETE" });
      if (!revoked.ok) throw new Error();
    } catch { return NextResponse.json({ detail: "Could not end your session. Please retry." }, { status: 503 }); }
  }
  const result = NextResponse.json({ ok: true });
  result.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
  return result;
}
