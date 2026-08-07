import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { migrateRevision6PetWake, REVISION_7_MARKER } = require("../desktop/linux-runtime/state-migrations.cjs");

test("revision 7 clears only the stale revision 6 pet wake state once", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chatgpt-state-migration-"));
  t.after(async () => { await rm(home, { recursive: true }); });
  const codexHome = path.join(home, ".codex");
  await mkdir(codexHome);
  const stateFile = path.join(codexHome, ".codex-global-state.json");
  await writeFile(stateFile, JSON.stringify({
    "electron-avatar-overlay-open": true,
    "unrelated-setting": { keep: true },
  }));

  assert.equal(migrateRevision6PetWake({ environment: {}, homeDirectory: home }), true);
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), {
    "electron-avatar-overlay-open": false,
    "unrelated-setting": { keep: true },
  });
  assert.match(await readFile(path.join(codexHome, REVISION_7_MARKER), "utf8"), /revision 6/);

  await writeFile(stateFile, JSON.stringify({ "electron-avatar-overlay-open": true }));
  assert.equal(migrateRevision6PetWake({ environment: {}, homeDirectory: home }), false);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8"))["electron-avatar-overlay-open"], true);
});

test("revision 7 leaves missing and malformed state untouched", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chatgpt-state-migration-"));
  t.after(async () => { await rm(home, { recursive: true }); });
  const warnings: unknown[] = [];
  assert.equal(migrateRevision6PetWake({ environment: {}, homeDirectory: home }), false);
  const codexHome = path.join(home, ".codex");
  await mkdir(codexHome);
  const stateFile = path.join(codexHome, ".codex-global-state.json");
  await writeFile(stateFile, "not json");
  assert.equal(migrateRevision6PetWake({
    environment: {},
    homeDirectory: home,
    logger: { warn: (...value: unknown[]) => warnings.push(value) },
  }), false);
  assert.equal(await readFile(stateFile, "utf8"), "not json");
  assert.equal(warnings.length, 1);
});
