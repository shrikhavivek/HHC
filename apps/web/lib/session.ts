import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import type { NextRequest } from "next/server";
export const SESSION_COOKIE = "hhc_editor_session";
export const sessionMaxAge = 60 * 60 * 8;
export type EditorSession = { id: string; username: string; site: string; exp: number; demo: boolean; authorization?: string };
function key() {
  const value = process.env.SESSION_SECRET || "";
  if (value.length < 32 || (process.env.APP_ENV === "production" && /^(local-|replace-)/.test(value))) throw new Error("Configure a random SESSION_SECRET");
  return createHash("sha256").update(value).digest();
}
export function createSession(session: EditorSession) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
}
export function verifySession(token?: string): EditorSession | null {
  try {
    if (!token || token.length > 4000) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    const data = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
    if (typeof data.username !== "string" || typeof data.site !== "string" || typeof data.id !== "string" || !Number.isFinite(data.exp) || data.exp <= Date.now() / 1000) return null;
    return data;
  } catch { return null; }
}
export async function internalRequest(path: string, init: RequestInit = {}) {
  return fetch(`${process.env.API_INTERNAL_URL || "http://localhost:8100"}/api/internal/${path}`, {
    ...init, headers: { "Content-Type": "application/json", "X-Editor-Key": process.env.EDITOR_API_KEY || "local-editor-key", ...init.headers },
    cache: "no-store", signal: AbortSignal.timeout(10000), redirect: "error",
  });
}
export async function authenticatedSession(request: NextRequest) {
  const session = verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  try {
    const response = await internalRequest(`sessions/${encodeURIComponent(session.id)}`);
    if (!response.ok) return null;
    const active = await response.json();
    return active.actor === session.username ? session : null;
  } catch { return null; }
}
export function sameOrigin(request: NextRequest) {
  return request.headers.get("origin") === (process.env.APP_ORIGIN || request.nextUrl.origin) && request.headers.get("sec-fetch-site") !== "cross-site";
}
export const cookieOptions = () => ({ httpOnly: true, sameSite: "strict" as const, secure: process.env.APP_ENV === "production" || process.env.COOKIE_SECURE === "true", path: "/", maxAge: sessionMaxAge });
