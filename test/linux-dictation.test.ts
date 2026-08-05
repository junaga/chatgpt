import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

// @ts-expect-error Packaged runtime modules intentionally ship as plain JavaScript.
import { skyLinuxBinary } from "../desktop/linux-runtime/linux-input.mjs";

const require = createRequire(import.meta.url);
const { enableLinuxDictation } = require("../desktop/linux-runtime/dictation.cjs");

const boundaries = [
  "function W7(){return process.platform===`darwin`||process.platform===`win32`}",
  "function uN(e,t,n){if(JM(e))",
  "function AN(e,t){return t===`darwin`?wN(e).length>0:EN(e,t)!=null}",
  "case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation hotkey release watching is not supported.`)}}function wN",
  "case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation paste is not supported on this OS.`)}}var B7",
];

test("the pinned bundle receives native Wayland and X11 dictation boundaries", () => {
  const patched = enableLinuxDictation(boundaries.join(" separator "));
  assert.match(patched, /process\.platform===`linux`/);
  assert.match(patched, /XDG_SESSION_TYPE===`wayland`/);
  assert.match(patched, /`watch-hotkey`,e/);
  assert.match(patched, /`wait-hotkey-release`,e/);
  assert.match(patched, /`paste`/);
  assert.match(patched, /linux-input\.mjs/);
  assert.match(patched, /t===`linux`\?hN\(e\)\.length>0/);
  assert.throws(() => enableLinuxDictation("missing"), /exactly one/);
});

test("the desktop bridge owns Wayland shortcut release and portal paste", async () => {
  const bridge = await readFile(
    new URL("../desktop/linux-desktop-bridge/src/bin/chatgpt-linux-desktop-bridge.rs", import.meta.url),
    "utf8",
  );
  assert.match(bridge, /GlobalShortcuts/);
  assert.match(bridge, /receive_activated/);
  assert.match(bridge, /receive_deactivated/);
  assert.match(bridge, /preferred_trigger/);
  assert.match(bridge, /RemoteDesktop/);
  assert.match(bridge, /PersistMode::ExplicitlyRevoked/);
  assert.match(bridge, /NotifyKeyboardKeysymOptions/);
});

test("dictation paste uses the packaged architecture-matched Sky helper", () => {
  assert.match(skyLinuxBinary({ arch: "x64", runtimeDirectory: "/opt/chatgpt/resources/linux-runtime" }), /sky_linux_x64$/);
  assert.match(skyLinuxBinary({ arch: "arm64", runtimeDirectory: "/opt/chatgpt/resources/linux-runtime" }), /sky_linux_arm64$/);
  assert.throws(() => skyLinuxBinary({ arch: "riscv64", runtimeDirectory: "/tmp" }), /Unsupported/);
});
