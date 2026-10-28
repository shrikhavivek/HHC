import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  // Hosted images redirect to signed Supabase links and uploads go straight to the bucket.
  const storage = " https://*.supabase.co";
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:${storage}; connect-src 'self'${storage}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
