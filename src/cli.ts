#!/usr/bin/env node
import { spawn, type StdioOptions } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { extractNodeReplSources } from "./node-repl-assets.ts";
import { nixRecipeWithTarballHash } from "./package-recipes.ts";
import { packageUniversalFormat, universalFormats, type UniversalFormat } from "./universal-packaging.ts";
import { loadUpstream, sha256, type UpstreamRelease } from "./upstream.ts";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireModule = createRequire(import.meta.url);
const upstreamFile = path.join(repository, "upstream.json");
const desktop = path.join(repository, "desktop");
const runtimeModules = path.join(desktop, "runtime");

type NativeFormat = "deb" | "rpm" | "archlinux" | "tar.gz";
type PackageFormat = NativeFormat | UniversalFormat;

interface Options {
  command: "inspect" | "build";
  dmg: string;
  output: string;
  work: string;
  keepWork: boolean;
  formats: PackageFormat[];
}

interface VendorRelease {
  version: string;
  build: string;
}

function usage(): never {
  console.error("Usage: npm run port -- <inspect|build> --dmg <ChatGPT.dmg> [--formats deb,rpm,archlinux,tar.gz,AppImage,snap,flatpak] [--output <dir>] [--work <dir>] [--keep-work]");
  process.exit(2);
}

function parseArguments(arguments_: string[]): Options {
  const command = arguments_.shift();
  if (command !== "inspect" && command !== "build") usage();
  let dmg = "";
  let output = path.join(repository, "dist");
  let work = path.join(repository, ".work");
  let keepWork = false;
  let formats: Options["formats"] = ["deb", "rpm", "archlinux", "tar.gz", ...universalFormats];
  while (arguments_.length) {
    const argument = arguments_.shift();
    if (argument === "--dmg") dmg = arguments_.shift() || "";
    else if (argument === "--output") output = path.resolve(arguments_.shift() || usage());
    else if (argument === "--work") work = path.resolve(arguments_.shift() || usage());
    else if (argument === "--keep-work") keepWork = true;
    else if (argument === "--formats") {
      const requested = (arguments_.shift() || "").split(",");
      const supported = new Set<string>(["deb", "rpm", "archlinux", "tar.gz", ...universalFormats]);
      if (requested.length === 0 || requested.some(format => !supported.has(format))) usage();
      formats = [...new Set(requested)] as Options["formats"];
    }
    else usage();
  }
  if (!dmg) usage();
  return { command, dmg: path.resolve(dmg), output, work, keepWork, formats };
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
  capture?: boolean;
  allowedExitCodes?: number[];
}

interface RunResult {
  code: number;
  output: string;
}

async function run(command: string, arguments_: string[], options: RunOptions = {}): Promise<RunResult> {
  if (!options.quiet) console.log(`→ ${command} ${arguments_.join(" ")}`);
  return await new Promise<RunResult>((resolve, reject) => {
    const stdio: StdioOptions = options.capture ? ["ignore", "pipe", "pipe"] : options.quiet ? "ignore" : "inherit";
    const child = spawn(command, arguments_, { cwd: options.cwd, env: options.env, stdio });
    let output = "";
    if (options.capture && child.stdout && child.stderr) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          output += chunk;
          if (!options.quiet) process.stdout.write(chunk);
        });
      }
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const numericCode = code ?? -1;
      if ((options.allowedExitCodes || [0]).includes(numericCode)) resolve({ code: numericCode, output });
      else reject(new Error(`${command} failed (${signal || `exit ${code}`})`));
    });
  });
}

async function requireFile(file: string, description: string): Promise<void> {
  try {
    await access(file, constants.R_OK);
  } catch {
    throw new Error(`${description} not found: ${file}`);
  }
}

async function validateExtractedApp(app: string, upstream: UpstreamRelease): Promise<VendorRelease> {
  const resources = path.join(app, "Contents", "Resources");
  const packageJson = JSON.parse(await readFile(path.join(resources, "app.asar.extracted", "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || typeof packageJson.codexBuildNumber !== "string") {
    throw new Error("Extracted app does not contain version and build metadata");
  }
  for (const module of Object.keys(upstream.nativeArtifacts)) {
    await requireFile(path.join(resources, "app.asar.extracted", "node_modules", module, "package.json"), `Native module ${module}`);
  }
  await requireFile(path.join(resources, "plugins"), "Bundled plugins");
  await requireFile(path.join(resources, "icon-chatgpt.png"), "Application icon");
  return { version: packageJson.version, build: packageJson.codexBuildNumber };
}

async function extract(dmg: string, root: string, upstream: UpstreamRelease): Promise<{ app: string; release: VendorRelease }> {
  const extracted = path.join(root, "dmg");
  await mkdir(extracted, { recursive: true });
  const extraction = await run("7z", ["x", dmg, `-o${extracted}`, "-y"], {
    capture: true,
    allowedExitCodes: [0, 2],
  });
  const app = path.join(extracted, upstream.appPath);
  if (extraction.code === 2) {
    const errors = extraction.output.split("\n").filter(line => line.startsWith("ERROR:"));
    const expected = new Set(upstream.acceptedExtractionWarnings.map(link => `${upstream.appPath}/${link}`));
    const actual = new Set<string>();
    for (const error of errors) {
      const match = error.match(/^ERROR: Dangerous link path was ignored : (.+?) : /);
      if (!match || !expected.has(match[1])) throw new Error(`Unexpected DMG extraction error: ${error}`);
      actual.add(match[1]);
    }
    if (actual.size !== expected.size) throw new Error("DMG extraction did not report the expected skipped symlinks");
  }
  const resources = path.join(app, "Contents", "Resources");
  await requireFile(path.join(resources, "app.asar"), "Electron ASAR");
  const vendorApp = path.join(resources, "app.asar.extracted");
  const asar = path.join(repository, "node_modules", ".bin", "asar");
  await run(asar, ["extract", path.join(resources, "app.asar"), vendorApp]);
  const release = await validateExtractedApp(app, upstream);
  return { app, release };
}

async function rebuildNativeModules(app: string, upstream: UpstreamRelease, electron: string): Promise<void> {
  const vendorApp = path.join(app, "Contents", "Resources", "app.asar.extracted");
  const nativeModules = Object.keys(upstream.nativeArtifacts);
  const rebuild = path.join(desktop, "node_modules", ".bin", "electron-rebuild");
  await requireFile(rebuild, "electron-rebuild");
  await run(rebuild, [
    "--force",
    "--version", electron,
    "--arch", "x64",
    "--platform", "linux",
    "--module-dir", desktop,
    "--only", nativeModules.join(","),
  ]);
  for (const module of nativeModules) {
    for (const artifact of upstream.nativeArtifacts[module]) {
      const source = path.join(desktop, "node_modules", module, artifact);
      const destination = path.join(vendorApp, "node_modules", module, artifact);
      await requireFile(source, `Rebuilt artifact ${module}/${artifact}`);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination);
    }
  }
}

async function desktopElectronVersion(): Promise<string> {
  const workspace = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  const electron = workspace.devDependencies?.electron;
  if (typeof electron !== "string" || !/^\d+\.\d+\.\d+$/.test(electron)) {
    throw new Error("desktop/package.json must pin an exact Electron version");
  }
  return electron;
}

async function desktopNodeVersion(): Promise<string> {
  const electron = path.join(desktop, "node_modules", "electron", "dist", "electron");
  const result = await run(electron, ["-p", "process.version"], {
    capture: true,
    quiet: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const version = result.output.trim();
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`Could not determine Electron's Node version: ${version}`);
  return version.slice(1);
}

async function writeDesktopPackageJson(destination: string, vendorApp: string): Promise<void> {
  const source = JSON.parse(await readFile(path.join(vendorApp, "package.json"), "utf8"));
  source.name = "chatgpt-linux-desktop";
  source.private = true;
  source.main = "launcher.cjs";
  delete source.scripts;
  delete source.dependencies;
  delete source.devDependencies;
  await writeFile(destination, `${JSON.stringify(source, null, 2)}\n`);
}

function linuxComputerUseDocumentation(source: string): string {
  const backendNote = `## Linux backend

The Linux wrapper keeps this API and confirmation policy unchanged. It combines
AT-SPI accessibility state with the bundled Sky capture/input client on X11 and
XDG Screenshot, ScreenCast, and Remote Desktop portals on Wayland. A Wayland
compositor may show a permission prompt and must provide those standard portals.
Screenshots contain the full desktop because neither backend exposes a reliable
app-window crop across mixed-scale displays; the accessibility tree remains
scoped to the approved app.
`;
  let documentation = source
    .replaceAll("Control local Mac apps", "Control local Linux apps")
    .replaceAll("local Mac apps", "local Linux apps")
    .replace(
      "(e.g. AppleScript, `osascript`, JXA, System Events, CGEvent synthesis)",
      "(for example, a purpose-built Linux accessibility tool explicitly requested by the user)",
    )
    .replace('target: "mac";', 'target: "linux";')
    .replace(
      "The `app` parameter may be either an app's display name, full app path, or bundle identifier.",
      "The `app` parameter may be an app's display name, desktop application ID, or `.desktop` file path.",
    )
    .replace(
      "the same operation with that app's bundle identifier from `list_apps()`",
      "the same operation with that app's desktop application ID from `list_apps()`",
    );
  const apiMarker = "## API surface";
  const policyMarker = "# Computer Use Confirmations Policy";
  if (documentation.includes(apiMarker)) {
    documentation = documentation.replace(apiMarker, `${backendNote}\n${apiMarker}`);
  } else if (documentation.includes(policyMarker)) {
    documentation = documentation.replace(policyMarker, `${backendNote}\n${policyMarker}`);
  } else {
    throw new Error("Upstream Computer Use documentation is missing its API/policy marker");
  }
  return documentation;
}

async function installLinuxPlugin(resources: string, installRoot: string, name: string): Promise<void> {
  const source = path.join(resources, "plugins", "openai-bundled", "plugins", name);
  const overlay = path.join(desktop, "linux-plugins", name);
  const destination = path.join(installRoot, "resources", "plugins", "openai-bundled", "plugins", name);
  await requireFile(path.join(overlay, ".codex-plugin", "plugin.json"), `Linux ${name} plugin`);
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  await cp(overlay, destination, { recursive: true, force: true });
  if (name === "computer-use") {
    for (const relative of [
      path.join(".codex-plugin", "computer-use-node-repl.md"),
      path.join("skills", "computer-use", "SKILL.md"),
    ]) {
      const documentation = linuxComputerUseDocumentation(
        await readFile(path.join(source, relative), "utf8"),
      );
      await writeFile(path.join(destination, relative), documentation);
    }
    await rm(path.join(destination, ".mcp.json"), { force: true });
    await rm(path.join(destination, "bin"), { recursive: true, force: true });
  } else {
    await chmod(path.join(destination, "bin", `${name}-launcher`), 0o755);
  }
}

async function installCuaNodeRuntime(resources: string, installRoot: string): Promise<void> {
  const source = path.join(resources, "cua_node");
  const destination = path.join(installRoot, "resources", "cua_node");
  const sourceModules = path.join(source, "lib", "node_modules");
  await requireFile(path.join(sourceModules, "@oai", "sky", "package.json"), "Bundled @oai/sky runtime");
  await cp(sourceModules, path.join(destination, "lib", "node_modules"), { recursive: true });

  const embedded = extractNodeReplSources(await readFile(path.join(source, "bin", "node_repl")));
  const kernelDirectory = path.join(destination, "lib", "node_repl");
  await mkdir(kernelDirectory, { recursive: true });
  for (const [filename, contents] of embedded.files) {
    await writeFile(path.join(kernelDirectory, filename), contents);
  }

  const wrappers = path.join(desktop, "linux-runtime", "bin");
  await mkdir(path.join(destination, "bin"), { recursive: true });
  for (const executable of ["node", "node_repl"]) {
    const target = path.join(destination, "bin", executable);
    await cp(path.join(wrappers, executable), target);
    await chmod(target, 0o755);
  }
  const codexWrapper = path.join(installRoot, "resources", "codex");
  await cp(path.join(wrappers, "codex"), codexWrapper);
  await chmod(codexWrapper, 0o755);
  await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify({
    platform: "linux",
    arch: process.arch,
    target: `linux-${process.arch}`,
    node_version: await desktopNodeVersion(),
    runtime_archive_name: "chatgpt-linux-cua-node",
    runtime_archive_version: "upstream-kernel/electron-node",
    node_path: "bin/node",
    node_modules: "lib/node_modules",
    node_repl_path: "bin/node_repl",
  }, null, 2)}\n`);
}

async function installChromeExtensionHost(installRoot: string): Promise<void> {
  const source = path.join(desktop, "linux-runtime", "bin", "extension-host");
  const extensionHostRoot = path.join(
    installRoot,
    "resources",
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome",
    "extension-host",
    "linux",
  );
  await requireFile(source, "Linux Chrome native messaging host");
  for (const architecture of ["x64", "arm64"]) {
    const destination = path.join(extensionHostRoot, architecture, "extension-host");
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
    await chmod(destination, 0o755);
  }
  const manifestInstaller = path.join(
    installRoot,
    "resources",
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome",
    "scripts",
    "installManifest.mjs",
  );
  await requireFile(manifestInstaller, "Chrome native-host manifest installer");
  const { patchChromeInstallManifestSource } = requireModule(
    path.join(desktop, "linux-runtime", "chrome-native-host.cjs"),
  ) as { patchChromeInstallManifestSource(source: string): string };
  await writeFile(
    manifestInstaller,
    patchChromeInstallManifestSource(await readFile(manifestInstaller, "utf8")),
  );
}

interface LinuxDesktopBinaries {
  computerUse: string;
  desktop: string;
}

async function buildLinuxDesktopBinaries(): Promise<LinuxDesktopBinaries> {
  const bridge = path.join(desktop, "linux-desktop-bridge");
  await run("cargo", ["build", "--release", "--locked"], { cwd: bridge });
  const binaries = {
    computerUse: path.join(bridge, "target", "release", "chatgpt-linux-computer-use"),
    desktop: path.join(bridge, "target", "release", "chatgpt-linux-desktop-bridge"),
  };
  await Promise.all([
    requireFile(binaries.computerUse, "Linux Computer Use bridge"),
    requireFile(binaries.desktop, "Linux desktop bridge"),
  ]);
  return binaries;
}

async function assemblePackageRoot(app: string, packageRoot: string, binaries: LinuxDesktopBinaries): Promise<void> {
  const installRoot = path.join(packageRoot, "opt", "chatgpt");
  const resources = path.join(app, "Contents", "Resources");
  await Promise.all([
    mkdir(path.join(installRoot, "resources", "app"), { recursive: true }),
    mkdir(path.join(packageRoot, "usr", "bin"), { recursive: true }),
    mkdir(path.join(packageRoot, "usr", "share", "applications"), { recursive: true }),
    mkdir(path.join(packageRoot, "usr", "share", "icons", "hicolor", "512x512", "apps"), { recursive: true }),
  ]);

  await cp(path.join(desktop, "node_modules", "electron", "dist"), installRoot, { recursive: true });
  await rename(path.join(installRoot, "electron"), path.join(installRoot, "codex-desktop"));
  const vendorApp = path.join(resources, "app.asar.extracted");
  await cp(vendorApp, path.join(installRoot, "resources", "app", "vendor-app"), { recursive: true });
  await cp(
    path.join(runtimeModules, "node_modules"),
    path.join(installRoot, "resources", "app", "vendor-app", "node_modules"),
    { recursive: true, verbatimSymlinks: true },
  );
  await cp(path.join(resources, "plugins"), path.join(installRoot, "resources", "plugins"), { recursive: true });
  await cp(path.join(desktop, "linux-runtime"), path.join(installRoot, "resources", "linux-runtime"), { recursive: true });
  const desktopBridgeDestination = path.join(installRoot, "resources", "linux-runtime", "bin", "chatgpt-linux-desktop-bridge");
  await cp(binaries.desktop, desktopBridgeDestination);
  await chmod(desktopBridgeDestination, 0o755);
  for (const destination of [
    path.join(installRoot, "resources", "linux-runtime", "bin", "chatgpt-linux-computer-use"),
    path.join(installRoot, "resources", "cua_node", "bin", "chatgpt-linux-computer-use"),
  ]) {
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(binaries.computerUse, destination);
    await chmod(destination, 0o755);
  }
  await installLinuxPlugin(resources, installRoot, "computer-use");
  await installCuaNodeRuntime(resources, installRoot);
  await installChromeExtensionHost(installRoot);
  await cp(path.join(desktop, "launcher.cjs"), path.join(installRoot, "resources", "app", "launcher.cjs"));
  await writeDesktopPackageJson(path.join(installRoot, "resources", "app", "package.json"), vendorApp);

  await cp(path.join(desktop, "packaging", "chatgpt"), path.join(packageRoot, "usr", "bin", "chatgpt"));
  await cp(path.join(desktop, "packaging", "chatgpt.desktop"), path.join(packageRoot, "usr", "share", "applications", "chatgpt.desktop"));
  await run("convert", [
    path.join(resources, "icon-chatgpt.png"),
    "-resize", "512x512",
    "-strip",
    path.join(packageRoot, "usr", "share", "icons", "hicolor", "512x512", "apps", "chatgpt.png"),
  ]);

  await chmod(path.join(packageRoot, "usr", "bin", "chatgpt"), 0o755);
  await chmod(path.join(installRoot, "codex-desktop"), 0o755);
  await chmod(path.join(installRoot, "chrome-sandbox"), 0o4755);
}

async function packageFormats(packageRoot: string, output: string, formats: Options["formats"], release: VendorRelease, upstream: UpstreamRelease, electron: string): Promise<string[]> {
  await mkdir(output, { recursive: true });
  const artifacts: string[] = [];
  for (const format of formats) {
    if (universalFormats.includes(format as UniversalFormat)) {
      artifacts.push(await packageUniversalFormat({
        electron,
        format: format as UniversalFormat,
        icon: path.join(packageRoot, "usr", "share", "icons", "hicolor", "512x512", "apps", "chatgpt.png"),
        output,
        prepackaged: path.join(packageRoot, "opt", "chatgpt"),
        project: repository,
        version: release.version,
      }));
      continue;
    }
    const filename = format === "archlinux" ? "chatgpt.pkg.tar.zst" : `chatgpt.${format}`;
    const artifact = path.join(output, filename);
    await rm(artifact, { force: true });
    if (format === "tar.gz") {
      await run("tar", [
        "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
        "-czf", artifact, "-C", packageRoot, ".",
      ]);
      artifacts.push(artifact);
      continue;
    }
    await run("nfpm", ["package", "--config", path.join(desktop, "packaging", "nfpm.yaml"), "--packager", format, "--target", artifact], {
      cwd: repository,
      env: {
        ...process.env,
        PACKAGE_ROOT: packageRoot,
        PACKAGE_VERSION: release.version,
        PACKAGE_RELEASE: String(upstream.portRevision),
      },
    });
    artifacts.push(artifact);
  }
  const recipes = [
    {
      source: path.join(repository, "packaging", "nix", "default.nix"),
      destination: path.join(output, "chatgpt.nix"),
    },
    {
      source: path.join(repository, "packaging", "gentoo", `chatgpt-${release.version}_p${upstream.portRevision}.ebuild`),
      destination: path.join(output, "chatgpt.ebuild"),
    },
  ];
  const tarball = artifacts.find(artifact => path.basename(artifact) === "chatgpt.tar.gz");
  for (const recipe of recipes) {
    await requireFile(recipe.source, "Package recipe");
    if (path.basename(recipe.destination) === "chatgpt.nix" && tarball) {
      const contents = nixRecipeWithTarballHash(
        await readFile(recipe.source, "utf8"),
        await sha256(tarball),
      );
      await writeFile(recipe.destination, contents);
    } else {
      await cp(recipe.source, recipe.destination);
    }
    artifacts.push(recipe.destination);
  }
  return artifacts;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await requireFile(options.dmg, "DMG");
  console.log("Hashing DMG…");
  const checksum = await sha256(options.dmg);
  const upstream = await loadUpstream(upstreamFile);
  if (checksum !== upstream.dmgSha256) {
    throw new Error(`Unsupported DMG SHA-256: ${checksum}\nExpected: ${upstream.dmgSha256}`);
  }
  console.log(`DMG matches this checkout: ${checksum}`);
  if (options.command === "inspect") return;
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Building currently requires Linux x86-64");

  console.log("Installing pinned Linux build dependencies…");
  await run("npm", ["ci", "--prefix", desktop]);
  await run("npm", ["ci", "--prefix", runtimeModules]);
  const electron = await desktopElectronVersion();

  const workRoot = path.join(options.work, checksum.slice(0, 16));
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
  const stop = async (code: number) => { await rm(workRoot, { recursive: true, force: true }); process.exit(code); };
  const interrupt = () => void stop(130); const terminate = () => void stop(143);
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  try {
    const { app, release } = await extract(options.dmg, workRoot, upstream);
    console.log(`Upstream release: ${release.version} (build ${release.build}, port revision ${upstream.portRevision})`);
    await rebuildNativeModules(app, upstream, electron);
    const packageRoot = path.join(workRoot, "package-root");
    const binaries = await buildLinuxDesktopBinaries();
    await assemblePackageRoot(app, packageRoot, binaries);
    const artifacts = await packageFormats(packageRoot, options.output, options.formats, release, upstream, electron);
    const report = {
      createdAt: new Date().toISOString(),
      upstreamVersion: release.version,
      buildNumber: release.build,
      portRevision: upstream.portRevision,
      dmgSha256: checksum,
      artifacts: await Promise.all(artifacts.map(async artifact => ({
        file: path.basename(artifact),
        sha256: await sha256(artifact),
      }))),
      electron,
      nativeModules: Object.keys(upstream.nativeArtifacts),
    };
    const reportFile = path.join(options.output, "chatgpt.build.json");
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    for (const artifact of report.artifacts) console.log(`Built ${artifact.file} (${artifact.sha256})`);
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
    if (!options.keepWork) await rm(workRoot, { recursive: true, force: true });
    else console.log(`Kept work directory: ${workRoot}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
