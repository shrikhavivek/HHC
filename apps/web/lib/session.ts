import { createHmac, timingSafeEqual } from "crypto";

export const SESSION_COOKIE = "hhc_editor_session";
const MAX_AGE_SECONDS = 60 * 60 * 8;

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return value;
}

function signature(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSession(username: string, site: string) {
  const payload = Buffer.from(JSON.stringify({ username, site, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function verifySession(token?: string) {
  if (!token) return null;
  const [payload, received] = token.split(".");
  if (!payload || !received) return null;
  const expected = signature(payload);
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data as { username: string; site: string; exp: number };
}

export const sessionMaxAge = MAX_AGE_SECONDS;

