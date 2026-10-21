import { NextRequest, NextResponse } from "next/server";
import { decodeHandoff, PENDING_COOKIE, handoffCookie, resultUrl } from "@/lib/wordpress-handoff";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const flow = decodeHandoff(request.cookies.get(PENDING_COOKIE)?.value);
  if (!flow || !flow.wpAuthorization || !flow.wpUsername) return NextResponse.json({ return_url: resultUrl(null, "expired").href }, { status: 401 });
  if (request.headers.get("origin") !== flow.callbackOrigin || request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ detail: "Invalid origin" }, { status: 403 });
  const authorization = flow.wpAuthorization;
  const username = flow.wpUsername;
  function finish(data: object, status = 200) {
    const result = NextResponse.json(data, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    result.cookies.set(PENDING_COOKIE, "", { ...handoffCookie(flow!.callbackOrigin), maxAge: 0 });
    return result;
  }
  try {
    const response = await fetch(`${process.env.API_INTERNAL_URL || "http://localhost:8100"}/api/internal/wordpress-handoffs/${flow.id}/complete`, {
      method: "POST", headers: { "X-Editor-Key": process.env.EDITOR_API_KEY || "local-editor-key", "X-Editor-Id": encodeURIComponent(username), "X-WP-Authorization": authorization },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) return finish({ return_url: resultUrl(flow, response.status === 409 ? "review" : "failed").href }, response.status);
    const result = await response.json();
    if (!Number.isSafeInteger(result.post_id) || result.post_id <= 0) throw new Error();
    // Use the discovered WordPress install path (HHC installs under /wp).
    const edit = new URL(`${flow.wpSite}/wp-admin/post.php`);
    edit.searchParams.set("post", String(result.post_id));
    edit.searchParams.set("action", "edit");
    return finish({ edit_url: edit.href, return_url: new URL(`/dashboard?case=${flow.caseId}&step=review`, flow.returnOrigin).href });
  } catch { return finish({ return_url: resultUrl(flow, "failed").href }, 502); }
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
