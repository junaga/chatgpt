import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = process.env.CODEX_DESKTOP_PACKAGE_ROOT || "/opt/chatgpt";
const electron = process.env.CODEX_DESKTOP_ELECTRON || path.join(packageRoot, "codex-desktop");
const helper = fileURLToPath(new URL("helpers/native-probe.cjs", import.meta.url));

function probe(arguments_, runAsNode = true) {
  const result = spawnSync(electron, [helper, ...arguments_], {
    encoding: "utf8",
    env: runAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("installed better-sqlite3 persists data across Electron processes", async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "chatgpt-linux-sqlite-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const database = path.join(temporaryRoot, "port-test.sqlite");
  probe(["sqlite", database, "write"]);
  probe(["sqlite", database, "read"]);
});

test("installed node-pty streams output and reports the child exit code", () => {
  probe(["pty"]);
});

test("installed node-pty terminates a running child", () => {
  probe(["pty-kill"]);
});

test("installed @parcel/watcher reports filesystem changes", async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "chatgpt-linux-watcher-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  probe(["watcher", temporaryRoot]);
});

test("installed desktop integration provides notifications and the codex URL handler", () => {
  if (process.env.CODEX_DESKTOP_PACKAGE_ROOT) return;
  probe(["desktop"], false);
});
