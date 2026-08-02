import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateManifest } from "./manifest.ts";

test("current upstream manifest is valid", async () => {
  const raw = JSON.parse(await readFile(new URL("manifests/26.727.40816.json", import.meta.url), "utf8"));
  const manifest = validateManifest(raw);
  assert.equal(manifest.upstreamVersion, "26.727.40816");
  assert.equal(manifest.electron.linuxCompatibility, "41.10.3");
  assert.deepEqual(manifest.nativeModules, ["better-sqlite3", "node-pty"]);
});

test("manifest validation rejects malformed checksums", () => {
  assert.throws(() => validateManifest({ dmgSha256: "nope" }), /SHA-256/);
});
