import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { NextRequest } from "next/server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = new Map();
function load(relative) {
  const file = resolve(root, relative);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const output = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const native = createRequire(file);
  const require = name => name.startsWith("@/") ? load(`${name.slice(2)}.ts`) : native(name);
  new Function("require", "module", "exports", output)(require, module, module.exports);
  return module.exports;
}
const session = load("lib/session.ts");
const handoff = load("lib/wordpress-handoff.ts");
const enter = load("app/api/auth/enter/route.ts");
const start = load("app/api/wordpress/start/route.ts");
const connect = load("app/api/wordpress/connect/route.ts");
const callback = load("app/api/wordpress/callback/route.ts");
const origin = "http://localhost:3100";
const wp = "https://wordpress.example";

function setup(t) {
  const old = { ...process.env };
  Object.assign(process.env, { APP_ENV: "development", APP_ORIGIN: origin, SESSION_SECRET: "test-only-secret-with-more-than-32-characters", API_INTERNAL_URL: "http://backend.example", WORDPRESS_SITE_URL: wp, EDITOR_API_KEY: "test-editor-key" });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); });
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === `${wp}/wp-json/`) return Response.json({ url: `${wp}/wp`, authentication: { "application-passwords": { endpoints: { authorization: `${wp}/wp/wp-admin/authorize-application.php` } } } });
    if (String(url).endsWith("/wordpress-handoffs")) return Response.json({ id: "d".repeat(64), expires_at: Math.floor(Date.now() / 1000) + 900 });
    if (String(url).endsWith("/complete")) return Response.json({ post_id: 123, status: "draft" });
    if (String(url).endsWith("/introspect")) return Response.json({ uuid: "12345678-1234-1234-1234-123456789abc" });
    return Response.json({ ok: true, actor: "Local editor" });
  };
  return calls;
}
function request(path, { method = "GET", body, cookie, host = origin, originHeader = origin } = {}) {
  return new NextRequest(`${host}${path}`, { method, headers: { ...(method === "POST" ? { origin: originHeader, "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function begin() {
  const response = await enter.POST(request("/api/auth/enter", { method: "POST" }));
  assert.equal(response.status, 200);
  const cookie = `${session.SESSION_COOKIE}=${response.cookies.get(session.SESSION_COOKIE).value}`;
  const pending = await start.POST(request("/api/wordpress/start", { method: "POST", cookie, body: { case_id: "case-1" } }));
  assert.equal(pending.status, 200);
  const bridge = new URL((await pending.json()).redirect_url);
  assert.equal(bridge.origin, "http://127.0.0.1:3100");
  const connected = await connect.GET(new NextRequest(bridge));
  const auth = new URL(connected.headers.get("location"));
  assert.equal(auth.pathname, "/wp/wp-admin/authorize-application.php");
  const flowCookie = `${handoff.HANDOFF_COOKIE}=${connected.cookies.get(handoff.HANDOFF_COOKIE).value}`;
  return { auth, flowCookie };
}
test("local entrance needs no credentials, rejects cross-site and production entry", async t => {
  setup(t);
  assert.equal((await enter.POST(request("/api/auth/enter", { method: "POST", originHeader: "https://other.example" }))).status, 403);
  const response = await enter.POST(request("/api/auth/enter", { method: "POST" }));
  const value = session.verifySession(response.cookies.get(session.SESSION_COOKIE).value);
  assert.equal(value.studio, true);
  assert.equal(value.authorization, undefined);
  process.env.APP_ENV = "production";
  assert.equal((await enter.POST(request("/api/auth/enter", { method: "POST" }))).status, 403);
});

test("incomplete stories show the validation error without waiting for WordPress", async t => {
  const calls = setup(t);
  const baseFetch = global.fetch;
  global.fetch = async (url, options) => String(url).endsWith("/wordpress-handoffs")
    ? Response.json({ detail: "Confirm the sources and usage rights for the latest collage" }, { status: 422 })
    : baseFetch(url, options);
  const entered = await enter.POST(request("/api/auth/enter", { method: "POST" }));
  const cookie = `${session.SESSION_COOKIE}=${entered.cookies.get(session.SESSION_COOKIE).value}`;
  const response = await start.POST(request("/api/wordpress/start", { method: "POST", cookie, body: { case_id: "case-1" } }));
  assert.equal(response.status, 422);
  assert.match((await response.json()).detail, /Confirm the sources/);
  assert.equal(calls.some(call => call.url.startsWith(wp)), false);
});
test("WordPress login returns to the exact draft and revokes the temporary credential", async t => {
  const calls = setup(t);
  const { auth, flowCookie } = await begin();
  assert.equal(calls.filter(c => c.url.endsWith("/complete")).length, 0);
  const returned = new URL(auth.searchParams.get("success_url"));
  returned.searchParams.set("site_url", `${wp}/wp`);
  returned.searchParams.set("user_login", "editor");
  returned.searchParams.set("password", "test-only-application-password");
  const response = await callback.GET(new NextRequest(returned, { headers: { cookie: flowCookie } }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${wp}/wp/wp-admin/post.php?post=123&action=edit`);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.cookies.get(handoff.HANDOFF_COOKIE).value, "");
  assert.equal(calls.filter(c => c.url.endsWith("/complete")).length, 1);
  assert.ok(calls.some(c => c.options.method === "DELETE" && c.url.includes("/application-passwords/")));
});
test("cancelled or forged WordPress callbacks never send a draft", async t => {
  const calls = setup(t);
  const { auth, flowCookie } = await begin();
  const cancelled = await callback.GET(new NextRequest(auth.searchParams.get("reject_url"), { headers: { cookie: flowCookie } }));
  assert.match(cancelled.headers.get("location"), /status=cancelled/);
  const forged = new URL(auth.searchParams.get("success_url"));
  forged.searchParams.set("state", "wrong-state");
  assert.match((await callback.GET(new NextRequest(forged, { headers: { cookie: flowCookie } }))).headers.get("location"), /status=expired/);
  assert.equal(calls.filter(c => c.url.endsWith("/complete")).length, 0);
});
test("expired intent and foreign WordPress site are rejected", async t => {
  const calls = setup(t);
  const { auth, flowCookie } = await begin();
  const returned = new URL(auth.searchParams.get("success_url"));
  returned.searchParams.set("site_url", "https://foreign.example");
  returned.searchParams.set("user_login", "editor");
  returned.searchParams.set("password", "test-only-password");
  assert.match((await callback.GET(new NextRequest(returned, { headers: { cookie: flowCookie } }))).headers.get("location"), /status=invalid/);
  const value = handoff.decodeHandoff(flowCookie.split("=")[1]);
  const expired = handoff.encodeHandoff({ ...value, exp: 1 });
  assert.equal(handoff.decodeHandoff(expired), null);
  assert.equal(calls.filter(c => c.url.endsWith("/complete")).length, 0);
});
