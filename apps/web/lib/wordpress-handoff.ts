import { NextResponse } from "next/server";
import { createSession, EditorSession, verifySession } from "@/lib/session";

export const HANDOFF_COOKIE = "hhc_wordpress_handoff";
export type Handoff = EditorSession & { purpose: "wordpress-handoff"; caseId: string; returnOrigin: string; callbackOrigin: string; wpSite: string; authorizeUrl: string };
export function wordpressSite() {
  const url = new URL(process.env.WORDPRESS_SITE_URL || "https://www.highheelconfidential.com");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid WordPress site");
  return url.href.replace(/\/$/, "");
}
export function encodeHandoff(value: Handoff) { return createSession(value); }
export function decodeHandoff(value?: string): Handoff | null {
  const data = verifySession(value) as Handoff | null;
  if (!data || data.purpose !== "wordpress-handoff" || !/^[a-f0-9]{64}$/.test(data.id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.caseId)) return null;
  try {
    if (data.site !== wordpressSite() || new URL(data.wpSite).origin !== new URL(data.site).origin || new URL(data.authorizeUrl).origin !== new URL(data.site).origin) return null;
    if (data.returnOrigin !== new URL(process.env.APP_ORIGIN || data.returnOrigin).origin) return null;
    return data;
  } catch { return null; }
}
export function handoffCookie(origin: string) {
  return { httpOnly: true, sameSite: "lax" as const, secure: new URL(origin).protocol === "https:", path: "/api/wordpress", maxAge: 900 };
}
export function privateRedirect(url: URL | string) {
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
export function handoffResult(flow: Handoff | null, status: string) {
  const url = new URL("/wordpress/result", flow?.returnOrigin || process.env.APP_ORIGIN || "http://localhost:3100");
  url.searchParams.set("status", status);
  const response = privateRedirect(url);
  if (flow) response.cookies.set(HANDOFF_COOKIE, "", { ...handoffCookie(flow.callbackOrigin), maxAge: 0 });
  return response;
}
