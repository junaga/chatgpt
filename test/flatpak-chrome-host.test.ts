import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { enableLinuxChromeNativeHostLifecycle, patchChromeInstallManifestSource, shellQuote, wrapperSource } = require("../desktop/linux-runtime/chrome-native-host.cjs");

test("Flatpak exposes host-visible Chrome wrapper and manifest locations", () => {
  const wrapper = wrapperSource({ flatpak: true });
  assert.match(wrapper, /flatpak run/);
  assert.match(wrapper, /--command=\/app\/bin\/codex-desktop/);
  assert.match(wrapper, /--env=ELECTRON_RUN_AS_NODE=1/);
  assert.match(wrapper, /CHATGPT_LINUX_EXTENSION_HOST_PATH="\$0"/);
  assert.match(wrapper, /io\.github\.junaga\.chatgpt/);
  assert.match(wrapper, /\/app\/lib\/io\.github\.junaga\.chatgpt\/resources\/linux-runtime\/chrome-extension-host\.mjs/);

  const source = "before xdgConfigHome:w.env.XDG_CONFIG_HOME extensionHostPath:_(t) after";
  assert.equal(
    patchChromeInstallManifestSource(source),
    "before xdgConfigHome:process.env.CHATGPT_LINUX_NATIVE_HOST_CONFIG_HOME||w.env.XDG_CONFIG_HOME extensionHostPath:process.env.CHATGPT_LINUX_NATIVE_HOST_WRAPPER||_(t) after",
  );
  assert.throws(() => patchChromeInstallManifestSource("no matching expression"), /found 0/);
});

test("native packages, AppImage, and Snap launch through their current resources tree", () => {
  const wrapper = wrapperSource({
    flatpak: false,
    resourcesPath: "/tmp/ChatGPT's current resources",
  });
  assert.match(wrapper, /resources='\/tmp\/ChatGPT'"'"'s current resources'/);
  assert.match(wrapper, /cua_node\/bin\/node/);
  assert.match(wrapper, /linux-runtime\/chrome-extension-host\.mjs/);
  assert.doesNotMatch(wrapper, /flatpak run/);
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});

test("the desktop lifecycle points every package format at the host-visible wrapper", () => {
  const source = [
    "r=await Hq({pluginRoot:e.pluginRoot,target:n})",
    "defaultConfigHome:(0,i.join)(r.default.homedir(),`.config`),xdgConfigHome:process.env.XDG_CONFIG_HOME}).map",
  ].join(" separator ");
  const patched = enableLinuxChromeNativeHostLifecycle(source);
  assert.match(patched, /CHATGPT_LINUX_NATIVE_HOST_WRAPPER/);
  assert.match(patched, /CHATGPT_LINUX_NATIVE_HOST_CONFIG_HOME/);
  assert.throws(() => enableLinuxChromeNativeHostLifecycle("missing"), /found 0/);
});
