import test from "node:test";
import assert from "node:assert/strict";
import { pollProvider } from "./browser-requests.mjs";

test("both sources can launch independently while login is pending, without duplicate launches", async () => {
  const running = new Set();
  const launches = [];
  const heartbeats = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const api = async (provider, path) => {
    if (path === "/heartbeat") { heartbeats.push(provider); return {}; }
    return { status: "queued", heartbeat: Date.now() / 1000 };
  };
  const launch = async provider => { launches.push(provider); await pending; };
  for (let i = 0; i < 3; i++) await Promise.all(["instagram", "reddit"].map(provider => pollProvider(provider, api, launch, running)));
  assert.deepEqual(launches.sort(), ["instagram", "reddit"]);
  assert.equal(heartbeats.length, 6);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(running.size, 0);
});

test("offline, expired, future and inactive requests never launch a source browser", async () => {
  for (const status of [{ status: "not_run" }, { status: "queued", heartbeat: Date.now() / 1000 - 181 }, { status: "queued", heartbeat: Date.now() / 1000 + 60 }, { status: "awaiting_login", heartbeat: Date.now() / 1000 }]) {
    await pollProvider("reddit", async () => status, () => assert.fail("must not launch"), new Set());
  }
  await assert.rejects(pollProvider("instagram", async () => { throw new Error("offline"); }, () => assert.fail("must not launch"), new Set()), /offline/);
});
