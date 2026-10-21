import { NextRequest, NextResponse } from "next/server";
import { authenticatedSession, internalRequest, sameOrigin } from "@/lib/session";
import { encodeHandoff, wordpressSite } from "@/lib/wordpress-handoff";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "Invalid origin" }, { status: 403 });
  const session = await authenticatedSession(request);
  if (!session) return NextResponse.json({ detail: "Open the studio again to continue." }, { status: 401 });
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 1024) throw new Error();
    body = JSON.parse(raw);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(body.case_id) || (body.reconcile !== undefined && typeof body.reconcile !== "boolean")) throw new Error();
  } catch { return NextResponse.json({ detail: "Select a saved story first." }, { status: 400 }); }
  try {
    // Surface missing story/review details before waiting for the external site.
    const prepared = await internalRequest("wordpress-handoffs", { method: "POST", body: JSON.stringify({ case_id: body.case_id, session_id: session.id, reconcile: Boolean(body.reconcile) }) });
    const pending = await prepared.json();
    if (!prepared.ok) return NextResponse.json({ detail: pending.detail || "Review and save your story before sending." }, { status: prepared.status });
    const site = wordpressSite();
    const discovery = await fetch(`${site}/wp-json/`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!discovery.ok) throw new Error();
    const info = await discovery.json();
    const authorizeUrl = new URL(info.authentication?.["application-passwords"]?.endpoints?.authorization);
    const wpSite = new URL(info.url);
    if (authorizeUrl.origin !== new URL(site).origin || wpSite.origin !== authorizeUrl.origin || !authorizeUrl.pathname.endsWith("/wp-admin/authorize-application.php")) throw new Error();
    const returnOrigin = new URL(process.env.APP_ORIGIN || request.nextUrl.origin).origin;
    const callback = new URL(returnOrigin);
    // WordPress accepts HTTP loopback IP callbacks, but not HTTP localhost.
    if (callback.protocol === "http:" && callback.hostname === "localhost") callback.hostname = "127.0.0.1";
    if (callback.protocol !== "https:" && !["127.0.0.1", "[::1]"].includes(callback.hostname)) throw new Error();
    const ticket = encodeHandoff({ id: pending.id, username: session.username, site, demo: false, exp: pending.expires_at, purpose: "wordpress-handoff", caseId: body.case_id, returnOrigin, callbackOrigin: callback.origin, wpSite: wpSite.href.replace(/\/$/, ""), authorizeUrl: authorizeUrl.href });
    // Set a browser-bound cookie on the callback host before visiting WordPress.
    const destination = new URL("/api/wordpress/connect", callback);
    destination.searchParams.set("ticket", ticket);
    return NextResponse.json({ redirect_url: destination.href }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ detail: "WordPress sign-in could not be opened. Your saved story is still here. Please try again." }, { status: 502 }); }
}
