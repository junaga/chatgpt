import { Arch, build as electronBuild, Platform, type Configuration } from "electron-builder";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import path from "node:path";

export const universalFormats = ["AppImage", "snap", "flatpak"] as const;
export type UniversalFormat = typeof universalFormats[number];

interface UniversalPackageOptions {
  electron: string;
  format: UniversalFormat;
  icon: string;
  output: string;
  prepackaged: string;
  project: string;
  version: string;
}

type FlatpakBundler = {
  bundle: (manifest: unknown, options: Record<string, unknown>) => Promise<unknown>;
};

export function flatpakBundlerOptionsWithoutRuntimeDownloads(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const builderArguments = Array.isArray(options.extraFlatpakBuilderArgs)
    ? options.extraFlatpakBuilderArgs
    : [];
  const exportArguments = Array.isArray(options.extraFlatpakBuildExportArgs)
    ? options.extraFlatpakBuildExportArgs
    : [];
  return {
    ...options,
    autoInstallBase: false,
    autoInstallRuntime: false,
    autoInstallSdk: false,
    extraFlatpakBuilderArgs: [
      ...builderArguments,
      ...builderArguments.includes("--disable-rofiles-fuse") ? [] : ["--disable-rofiles-fuse"],
    ],
    extraFlatpakBuildExportArgs: [
      ...exportArguments,
      ...exportArguments.includes("--disable-sandbox") ? [] : ["--disable-sandbox"],
    ],
  };
}

async function buildUniversalTarget(options: UniversalPackageOptions): Promise<string[]> {
  const buildOptions = {
    projectDir: options.project,
    prepackaged: options.prepackaged,
    targets: Platform.LINUX.createTarget(options.format, Arch.x64),
    config: universalPackageConfiguration(options),
  };
  if (options.format !== "flatpak") return electronBuild(buildOptions);

  // @malept/flatpak-bundler otherwise downloads a full runtime, SDK, and
  // Electron base even though it invokes flatpak-builder with
  // --allow-missing-runtimes for this prepackaged app with no build modules.
  const require = createRequire(import.meta.url);
  const bundler = require("@malept/flatpak-bundler") as FlatpakBundler;
  const bundle = bundler.bundle;
  bundler.bundle = (manifest, bundlerOptions) => bundle(
    manifest,
    flatpakBundlerOptionsWithoutRuntimeDownloads(bundlerOptions),
  );
  try {
    return await electronBuild(buildOptions);
  } finally {
    bundler.bundle = bundle;
  }
}

export function universalPackageConfiguration(options: UniversalPackageOptions): Configuration {
  return {
    appId: "io.github.junaga.chatgpt",
    productName: "ChatGPT",
    electronVersion: options.electron,
    extraMetadata: {
      name: "chatgpt",
      productName: "ChatGPT",
      version: options.version,
      description: "Experimental ChatGPT Codex desktop compatibility port for Linux",
      author: "ChatGPT Linux contributors",
      desktopName: "chatgpt.desktop",
    },
    directories: {
      output: options.output,
      buildResources: path.dirname(options.icon),
    },
    protocols: [
      {
        name: "Codex",
        schemes: ["codex"],
      },
    ],
    linux: {
      artifactName: "chatgpt.${ext}",
      category: "Development",
      description: "Experimental ChatGPT Codex desktop compatibility port for Linux.",
      executableName: "codex-desktop",
      icon: options.icon,
      maintainer: "ChatGPT Linux contributors <noreply@github.com>",
      syncDesktopName: true,
      synopsis: "ChatGPT Codex desktop app compatibility port",
      target: [options.format],
      desktop: {
        entry: {
          Name: "ChatGPT",
          Comment: "ChatGPT Codex desktop app compatibility port",
          Categories: "Development;Utility;",
          StartupWMClass: "ChatGPT",
          "X-GNOME-UsesNotifications": "true",
        },
      },
    },
    appImage: {
      artifactName: "chatgpt.${ext}",
    },
    snap: {
      artifactName: "chatgpt.${ext}",
      allowNativeWayland: true,
      confinement: "classic",
      grade: "stable",
      summary: "ChatGPT Codex desktop app compatibility port",
    },
    flatpak: {
      artifactName: "chatgpt.${ext}",
      baseVersion: "24.08",
      branch: "stable",
      runtimeVersion: "24.08",
      useWaylandFlags: true,
      finishArgs: [
        "--share=ipc",
        "--share=network",
        "--socket=fallback-x11",
        "--socket=wayland",
        "--socket=pulseaudio",
        "--device=dri",
        "--filesystem=home",
        "--filesystem=/tmp",
        "--talk-name=org.a11y.Bus",
        "--talk-name=org.freedesktop.Notifications",
        "--talk-name=org.freedesktop.portal.Desktop",
        "--talk-name=org.freedesktop.secrets",
      ],
    },
  };
}

export async function packageUniversalFormat(options: UniversalPackageOptions): Promise<string> {
  const filename = options.format === "AppImage" ? "chatgpt.AppImage" : `chatgpt.${options.format}`;
  const artifacts = await buildUniversalTarget(options);
  // The port deliberately has no in-app updater. Do not leave update-channel
  // metadata beside the standalone downloads.
  await rm(path.join(options.output, "latest-linux.yml"), { force: true });
  const expected = path.join(options.output, filename);
  if (!artifacts.includes(expected)) {
    throw new Error(`electron-builder did not produce ${filename}`);
  }
  return expected;
}
