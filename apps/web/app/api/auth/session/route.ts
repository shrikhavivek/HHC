import { NextRequest, NextResponse } from "next/server";
import { authenticatedSession } from "@/lib/session";
export async function GET(request: NextRequest) {
  const session = await authenticatedSession(request);
  if (!session) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({ authenticated: true, username: session.username, site: session.site, demo: session.demo, studio: Boolean(session.studio) }, { headers: { "Cache-Control": "no-store" } });
}
