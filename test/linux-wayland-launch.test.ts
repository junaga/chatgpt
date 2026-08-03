import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { configureNativeWayland, isWaylandSession } = require("../desktop/linux-runtime/wayland.cjs");

function fakeApp(initialPlatform = "") {
  const switches = new Map<string, string>();
  if (initialPlatform) switches.set("ozone-platform", initialPlatform);
  return {
    commandLine: {
      appendSwitch(name: string, value: string) { switches.set(name, value); },
      getSwitchValue(name: string) { return switches.get(name) ?? ""; },
      hasSwitch(name: string) { return switches.has(name); },
    },
  };
}

test("Wayland sessions explicitly launch Electron through native Wayland", () => {
  const app = fakeApp();
  assert.equal(configureNativeWayland(app, {
    environment: {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-1",
      DISPLAY: ":0",
    },
  }), true);
  assert.equal(app.commandLine.getSwitchValue("ozone-platform"), "wayland");
});

test("explicit platform choices and X11 sessions are preserved", () => {
  const forcedX11 = fakeApp("x11");
  assert.equal(configureNativeWayland(forcedX11, {
    environment: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1" },
  }), false);
  assert.equal(forcedX11.commandLine.getSwitchValue("ozone-platform"), "x11");

  const x11 = fakeApp();
  assert.equal(configureNativeWayland(x11, {
    environment: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
  }), false);
  assert.equal(x11.commandLine.hasSwitch("ozone-platform"), false);
});

test("WAYLAND_DISPLAY is used only when the session type is absent", () => {
  assert.equal(isWaylandSession({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" }), true);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-1" }), false);
});
