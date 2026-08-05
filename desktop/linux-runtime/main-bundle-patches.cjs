const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const { enableLinuxChromeNativeHostLifecycle } = require("./chrome-native-host.cjs");
const { enableLinuxComputerUse } = require("./computer-use.cjs");
const { enableLinuxDictation } = require("./dictation.cjs");
const { enableLinuxSystemPermissions } = require("./notifications.cjs");
const { enableLinuxPictureInPicture } = require("./picture-in-picture.cjs");
const { enableLinuxRemoteControlDeviceKeys } = require("./remote-control-device-key.cjs");

function composeLinuxMainBundle(source) {
  return enableLinuxComputerUse(
    enableLinuxDictation(
      enableLinuxPictureInPicture(
        enableLinuxRemoteControlDeviceKeys(enableLinuxSystemPermissions(source)),
      ),
    ),
  );
}

function installLinuxMainBundlePatches(vendorAppRoot) {
  const buildRoot = path.join(vendorAppRoot, ".vite", "build");
  const mainBundles = fs.readdirSync(buildRoot).filter(filename => /^main-.+\.js$/.test(filename));
  if (mainBundles.length !== 1) {
    throw new Error(`Expected one upstream main bundle, found ${mainBundles.length}`);
  }

  const mainBundle = path.resolve(buildRoot, mainBundles[0]);
  const chromeLifecycleBundles = fs.readdirSync(buildRoot)
    .filter(filename => filename.endsWith(".js"))
    .filter(filename => fs.readFileSync(path.join(buildRoot, filename), "utf8").includes("chrome-native-hosts-v2.json"));
  if (chromeLifecycleBundles.length !== 1) {
    throw new Error(`Expected one upstream Chrome lifecycle bundle, found ${chromeLifecycleBundles.length}`);
  }
  const transformations = new Map([
    [mainBundle, composeLinuxMainBundle],
    [path.resolve(buildRoot, chromeLifecycleBundles[0]), enableLinuxChromeNativeHostLifecycle],
  ]);
  const originalLoader = Module._extensions[".js"];
  Module._extensions[".js"] = function linuxParityPatchedLoader(module, filename) {
    const transform = transformations.get(path.resolve(filename));
    if (!transform) return originalLoader(module, filename);
    const source = fs.readFileSync(filename, "utf8");
    module._compile(transform(source), filename);
  };
}

module.exports = { composeLinuxMainBundle, installLinuxMainBundlePatches };
