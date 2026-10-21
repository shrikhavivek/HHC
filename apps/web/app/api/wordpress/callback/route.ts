import { NextRequest } from "next/server";
import { decodeHandoff, encodeHandoff, HANDOFF_COOKIE, PENDING_COOKIE, handoffCookie, handoffResult, privateRedirect } from "@/lib/wordpress-handoff";

export async function GET(request: NextRequest) {
  const flow = decodeHandoff(request.cookies.get(HANDOFF_COOKIE)?.value);
  const params = request.nextUrl.searchParams;
  if (!flow || params.get("state") !== flow.id) return handoffResult(null, "expired");
  if (params.get("cancelled") === "1") return handoffResult(flow, "cancelled");
  const username = params.get("user_login") || "";
  const password = params.get("password") || "";
  if (!username || username.length > 120 || username.includes(":") || !password || password.length > 256 || params.get("site_url")?.replace(/\/$/, "") !== flow.wpSite) return handoffResult(flow, "invalid");
  // Move credentials out of the callback URL before rendering the progress page.
  // Only the server can read this encrypted, temporary HttpOnly cookie.
  const pending = encodeHandoff({ ...flow, wpUsername: username, wpAuthorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` });
  const destination = new URL("/wordpress/complete", flow.callbackOrigin);
  const response = privateRedirect(destination);
  response.cookies.set(PENDING_COOKIE, pending, handoffCookie(flow.callbackOrigin));
  response.cookies.set(HANDOFF_COOKIE, "", { ...handoffCookie(flow.callbackOrigin), maxAge: 0 });
  return response;
}
