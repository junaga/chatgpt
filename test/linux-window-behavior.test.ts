import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { enableNativeLinuxWindowBehavior } = require("../desktop/linux-runtime/window-behavior.cjs");

const titlebar = "n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:A9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}}";
const closeToTray = "(process.platform===`win32`||process.platform===`linux`)&&!this.isAppQuitting&&this.options.canHideLastWindowToTray?.()===!0&&!t";

test("Linux primary windows use native decorations and close instead of hiding to tray", () => {
  const patched = enableNativeLinuxWindowBehavior(`${titlebar} ${closeToTray}`);
  assert.match(patched, /n===`win32`\?\{titleBarStyle:`hidden`,titleBarOverlay:A9\(r\)/);
  assert.match(patched, /:\{titleBarStyle:`default`,\.\.\.e===`quickChat`/);
  assert.doesNotMatch(patched, /n===`win32`\|\|n===`linux`\?\{titleBarStyle:`hidden`/);
  assert.match(patched, /process\.platform===`win32`&&!this\.isAppQuitting/);
  assert.doesNotMatch(patched, /process\.platform===`win32`\|\|process\.platform===`linux`/);
});

test("Linux window patch refuses an upstream bundle whose protected boundaries drift", () => {
  assert.throws(() => enableNativeLinuxWindowBehavior(titlebar), /close-to-tray/);
  assert.throws(() => enableNativeLinuxWindowBehavior(closeToTray), /titlebar/);
  assert.throws(() => enableNativeLinuxWindowBehavior(`${titlebar} ${titlebar} ${closeToTray}`), /titlebar/);
  assert.throws(() => enableNativeLinuxWindowBehavior(`${titlebar} ${closeToTray} ${closeToTray}`), /close-to-tray/);
});
