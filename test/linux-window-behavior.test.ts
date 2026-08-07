import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const moduleLoader = require("node:module") as { _extensions: Record<string, Function> };
const { composeLinuxMainBundle } = require("../desktop/linux-runtime/main-bundle-patches.cjs");
const { enableNativeLinuxWindowBehavior } = require("../desktop/linux-runtime/window-behavior.cjs");
const { installLinuxMainBundlePatches } = require("../desktop/linux-runtime/main-bundle-patches.cjs");

const titlebar = "n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:A9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}}";
const closeToTray = "if((process.platform===`win32`||process.platform===`linux`)&&!this.isAppQuitting&&this.options.canHideLastWindowToTray?.()===!0&&!t){}";

test("Linux primary windows use native decorations and close instead of hiding to tray", () => {
  const patched = enableNativeLinuxWindowBehavior(`${titlebar};${closeToTray}`);
  assert.match(patched, /n===`win32`\?\{titleBarStyle:`hidden`,titleBarOverlay:A9\(r\)/);
  assert.match(patched, /:\{titleBarStyle:`default`,\.\.\.e===`quickChat`/);
  assert.doesNotMatch(patched, /n===`win32`\|\|n===`linux`\?\{titleBarStyle:`hidden`/);
  assert.match(patched, /if\(process\.platform===`win32`&&!this\.isAppQuitting/);
  assert.doesNotMatch(patched, /process\.platform===`win32`\|\|process\.platform===`linux`/);
  assert.doesNotThrow(() => new Script(`(() => { ${patched} })()`));
});

test("the pinned packaged main bundle compiles after the complete Linux transform", () => {
  const bundle = process.env.CODEX_DESKTOP_MAIN_BUNDLE || "/opt/chatgpt/resources/app/vendor-app/.vite/build/main-i-HoRaar.js";
  try {
    const source = readFileSync(bundle, "utf8");
    assert.doesNotThrow(() => new Script(composeLinuxMainBundle(source)));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
});

test("Linux window patch refuses an upstream bundle whose protected boundaries drift", () => {
  assert.throws(() => enableNativeLinuxWindowBehavior(titlebar), /close-to-tray/);
  assert.throws(() => enableNativeLinuxWindowBehavior(closeToTray), /titlebar/);
  assert.throws(() => enableNativeLinuxWindowBehavior(`${titlebar} ${titlebar} ${closeToTray}`), /titlebar/);
  assert.throws(() => enableNativeLinuxWindowBehavior(`${titlebar} ${closeToTray} ${closeToTray}`), /close-to-tray/);
});

test("packaged main-bundle loader installation is idempotent", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-main-loader-"));
  t.after(async () => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }));
  const build = path.join(root, ".vite", "build");
  await mkdir(build, { recursive: true });
  await writeFile(path.join(build, "main-fixture.js"), "module.exports = {};\n");
  await writeFile(path.join(build, "chrome-fixture.js"), "// chrome-native-hosts-v2.json\n");
  installLinuxMainBundlePatches(root);
  const installedLoader = moduleLoader._extensions[".js"];
  installLinuxMainBundlePatches(root);
  assert.equal(moduleLoader._extensions[".js"], installedLoader);
});
