import assert from "node:assert/strict";
import test from "node:test";
import { loadUpstream, validateUpstream } from "../src/upstream.ts";

test("the supported upstream release is valid", async () => {
  const upstream = await loadUpstream(new URL("../upstream.json", import.meta.url).pathname);
  assert.equal(upstream.portRevision, 2);
  assert.deepEqual(Object.keys(upstream.nativeArtifacts), ["better-sqlite3", "node-pty"]);
});

test("upstream validation rejects malformed checksums", () => {
  assert.throws(() => validateUpstream({ dmgSha256: "nope" }), /SHA-256/);
});
