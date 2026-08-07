import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const { enableNativeLinuxWindowBehavior } = require("../desktop/linux-runtime/window-behavior.cjs");

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

test("the packaged main bundle remains compilable after Linux window patching", () => {
  const bundle = "/opt/chatgpt/resources/app/vendor-app/.vite/build/main-i-HoRaar.js";
  try {
    const source = readFileSync(bundle, "utf8");
    assert.doesNotThrow(() => new Script(enableNativeLinuxWindowBehavior(source)));
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
