import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadUpstream, validateUpstream } from "../src/upstream.ts";

test("the supported upstream release is valid", async () => {
  const upstream = await loadUpstream(new URL("../upstream.json", import.meta.url).pathname);
  assert.equal(upstream.portRevision, 5);
  assert.equal(upstream.codexVersion, "0.147.0-alpha.1.2");
  assert.equal(upstream.linuxRuntimeCodexVersion, "0.148.0-alpha.1");
  assert.deepEqual(Object.keys(upstream.nativeArtifacts), ["better-sqlite3", "node-pty"]);

  const runtimeManifest = JSON.parse(
    await readFile(new URL("../desktop/runtime/package.json", import.meta.url), "utf8"),
  );
  assert.equal(runtimeManifest.dependencies["@openai/codex"], upstream.linuxRuntimeCodexVersion);
});

test("the Linux runtime resolves the queued-message dispatch release", async () => {
  const lock = JSON.parse(await readFile(new URL("../desktop/runtime/package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.packages["node_modules/@openai/codex"].version, "0.148.0-alpha.1");
  assert.equal(lock.packages["node_modules/@openai/codex-linux-x64"].version, "0.148.0-alpha.1-linux-x64");
});

test("upstream validation rejects malformed checksums", () => {
  assert.throws(() => validateUpstream({ archiveSha256: "nope" }), /SHA-256/);
});
