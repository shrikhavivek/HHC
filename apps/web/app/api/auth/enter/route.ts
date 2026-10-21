import { NextResponse } from "next/server";

// Retired endpoint: old clients must use the editor login, including on localhost.
export async function POST() {
  return NextResponse.json({ detail: "Sign in with your editor username and password." }, { status: 403 });
}
