import { NextRequest } from "next/server";
import { decodeHandoff, HANDOFF_COOKIE, handoffCookie, handoffResult, privateRedirect } from "@/lib/wordpress-handoff";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const flow = decodeHandoff(request.cookies.get(HANDOFF_COOKIE)?.value);
  const params = request.nextUrl.searchParams;
  if (!flow || params.get("state") !== flow.id) return handoffResult(null, "expired");
  if (params.get("cancelled") === "1") return handoffResult(flow, "cancelled");
  const username = params.get("user_login") || "";
  const password = params.get("password") || "";
  if (!username || username.length > 120 || username.includes(":") || !password || password.length > 256 || params.get("site_url")?.replace(/\/$/, "") !== flow.wpSite) return handoffResult(flow, "invalid");
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  try {
    const response = await fetch(`${process.env.API_INTERNAL_URL || "http://localhost:8100"}/api/internal/wordpress-handoffs/${flow.id}/complete`, {
      method: "POST", headers: { "X-Editor-Key": process.env.EDITOR_API_KEY || "local-editor-key", "X-Editor-Id": encodeURIComponent(username), "X-WP-Authorization": authorization },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) return handoffResult(flow, response.status === 409 ? "review" : "failed");
    const result = await response.json();
    if (!Number.isSafeInteger(result.post_id) || result.post_id <= 0) throw new Error();
    // Use the discovered WordPress install path (HHC installs under /wp).
    const edit = new URL(`${flow.wpSite}/wp-admin/post.php`);
    edit.searchParams.set("post", String(result.post_id));
    edit.searchParams.set("action", "edit");
    const redirect = privateRedirect(edit);
    redirect.cookies.set(HANDOFF_COOKIE, "", { ...handoffCookie(flow.callbackOrigin), maxAge: 0 });
    return redirect;
  } catch { return handoffResult(flow, "failed"); }
  finally {
    // This authorization is used for one handoff, never kept in browser storage
    // or application logs. Revoke it after the handoff, including failures.
    try {
      const base = `${flow.site}/wp-json/wp/v2/users/me/application-passwords`;
      const options = { headers: { Authorization: authorization }, redirect: "error" as const, cache: "no-store" as const, signal: AbortSignal.timeout(8000) };
      const introspection = await fetch(`${base}/introspect`, options);
      if (introspection.ok) {
        const current = await introspection.json();
        if (/^[a-f0-9-]{36}$/i.test(current.uuid)) await fetch(`${base}/${current.uuid}`, { ...options, method: "DELETE", signal: AbortSignal.timeout(8000) });
      }
    } catch { /* Revocation can also be performed in the WordPress profile. */ }
  }
}
