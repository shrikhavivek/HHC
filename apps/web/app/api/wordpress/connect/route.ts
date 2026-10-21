import { NextRequest } from "next/server";
import { decodeHandoff, HANDOFF_COOKIE, handoffCookie, handoffResult, privateRedirect } from "@/lib/wordpress-handoff";

export async function GET(request: NextRequest) {
  const ticket = request.nextUrl.searchParams.get("ticket") || "";
  const flow = decodeHandoff(ticket);
  if (!flow) return handoffResult(null, "expired");
  const callback = new URL("/api/wordpress/callback", flow.callbackOrigin);
  callback.searchParams.set("state", flow.id);
  const reject = new URL(callback);
  reject.searchParams.set("cancelled", "1");
  const authorize = new URL(flow.authorizeUrl);
  authorize.searchParams.set("app_name", `HHC Editorial Studio ${flow.id.slice(0, 8)}`);
  authorize.searchParams.set("success_url", callback.href);
  authorize.searchParams.set("reject_url", reject.href);
  const response = privateRedirect(authorize);
  response.cookies.set(HANDOFF_COOKIE, ticket, handoffCookie(flow.callbackOrigin));
  return response;
}
