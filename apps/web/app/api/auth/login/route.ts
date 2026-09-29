import { NextRequest, NextResponse } from "next/server";
import { createSession, SESSION_COOKIE, sessionMaxAge } from "@/lib/session";

export async function POST(request: NextRequest) {
  const { username, applicationPassword } = await request.json();
  if (!username || !applicationPassword) return NextResponse.json({ detail: "Username and Application Password are required." }, { status: 400 });

  const site = (process.env.WORDPRESS_SITE_URL || "https://www.highheelconfidential.com").replace(/\/$/, "");
  if (process.env.DEMO_LOGIN_ENABLED === "true" && username === process.env.DEMO_USERNAME) {
    if (applicationPassword !== process.env.DEMO_PASSWORD) {
      return NextResponse.json({ detail: "Invalid temporary demo credentials." }, { status: 401 });
    }
    const demoResponse = NextResponse.json({ ok: true, username, demo: true });
    demoResponse.cookies.set(SESSION_COOKIE, createSession(username, site), {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.COOKIE_SECURE === "true",
      path: "/",
      maxAge: sessionMaxAge,
    });
    return demoResponse;
  }
  const authorization = Buffer.from(`${username}:${applicationPassword}`).toString("base64");
  let response: Response;
  try {
    response = await fetch(`${site}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { Authorization: `Basic ${authorization}`, "User-Agent": "HHC-Outfit-Research/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return NextResponse.json({ detail: "High Heel Confidential could not be reached. Try again shortly." }, { status: 502 });
  }
  if (!response.ok) return NextResponse.json({ detail: "WordPress rejected those credentials. Use your username and an Application Password from your WordPress profile." }, { status: 401 });
  const user = await response.json();
  const result = NextResponse.json({ ok: true, username: user.name || username });
  result.cookies.set(SESSION_COOKIE, createSession(username, site), {
    httpOnly: true, sameSite: "strict", secure: process.env.COOKIE_SECURE === "true", path: "/", maxAge: sessionMaxAge,
  });
  return result;
}
