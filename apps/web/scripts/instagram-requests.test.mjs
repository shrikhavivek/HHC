import test from "node:test";
import assert from "node:assert/strict";
import { pollForScan } from "./instagram-requests.mjs";

test("idle polling sends heartbeats without launching any processes", async () => {
  let launches = 0;
  let heartbeats = 0;
  for (const status of ["not_run", "completed", "partial", "cancelled", "awaiting_login", "running"]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await pollForScan(async path => {
        if (path === "/heartbeat") { heartbeats++; return { ok: true }; }
        assert.equal(path, "/status");
        return { status, heartbeat: Date.now() / 1000 };
      }, async () => { launches++; });
    }
  }
  assert.equal(heartbeats, 18);
  assert.equal(launches, 0);
});

test("only a fresh queued scan launches the collector", async () => {
  let launches = 0;
  let heartbeat = Date.now() / 1000;
  const api = async path => path === "/heartbeat" ? { ok: true } : { status: "queued", heartbeat };
  await pollForScan(api, async () => { launches++; });
  assert.equal(launches, 1);
  heartbeat -= 181;
  await pollForScan(api, async () => { launches++; });
  assert.equal(launches, 1);
});

test("an unavailable local API cannot launch a browser", async () => {
  await assert.rejects(pollForScan(async () => { throw new Error("offline"); }, async () => { assert.fail("must not launch"); }), /offline/);
});
