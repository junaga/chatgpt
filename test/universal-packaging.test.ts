import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  flatpakBundlerOptionsWithoutRuntimeDownloads,
  universalPackageConfiguration,
  universalFormats,
} from "../src/universal-packaging.ts";

test("one electron-builder configuration describes every universal Linux package", () => {
  assert.deepEqual(universalFormats, ["AppImage", "snap", "flatpak"]);
  for (const format of universalFormats) {
    const config = universalPackageConfiguration({
      electron: "41.10.3",
      format,
      icon: "/work/icon.png",
      output: "/work/dist",
      prepackaged: "/work/app",
      project: "/work/project",
      version: "26.727.40816",
    });
    assert.deepEqual(config.linux?.target, [format]);
    assert.equal(config.linux?.artifactName, "chatgpt.${ext}");
    assert.equal(config.linux?.executableName, "codex-desktop");
    assert.equal(config.directories?.buildResources, path.dirname("/work/icon.png"));
    assert.deepEqual(config.protocols, [{ name: "Codex", schemes: ["codex"] }]);
  }
});

test("sandboxed package settings retain desktop-control and notification portals", () => {
  const config = universalPackageConfiguration({
    electron: "41.10.3",
    format: "flatpak",
    icon: "/work/icon.png",
    output: "/work/dist",
    prepackaged: "/work/app",
    project: "/work/project",
    version: "26.727.40816",
  });
  assert.equal(config.snap?.confinement, "classic");
  assert.equal(config.snap?.allowNativeWayland, true);
  assert.ok(config.flatpak?.finishArgs?.includes("--socket=wayland"));
  assert.ok(config.flatpak?.finishArgs?.includes("--talk-name=org.freedesktop.portal.Desktop"));
  assert.ok(config.flatpak?.finishArgs?.includes("--talk-name=org.a11y.Bus"));
});

test("prepackaged Flatpak builds do not download unused SDK and runtime images", () => {
  assert.deepEqual(
    flatpakBundlerOptionsWithoutRuntimeDownloads({ arch: "x86_64", autoInstallSdk: true }),
    {
      arch: "x86_64",
      autoInstallBase: false,
      autoInstallRuntime: false,
      autoInstallSdk: false,
      extraFlatpakBuildExportArgs: ["--disable-sandbox"],
      extraFlatpakBuilderArgs: ["--disable-rofiles-fuse"],
    },
  );
});
