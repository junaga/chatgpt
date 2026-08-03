#!/usr/bin/env node
import { spawn, type StdioOptions } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadUpstream, sha256, type UpstreamRelease } from "./upstream.ts";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstreamFile = path.join(repository, "upstream.json");
const desktop = path.join(repository, "desktop");
const runtimeModules = path.join(desktop, "runtime");

interface Options {
  command: "inspect" | "build";
  dmg: string;
  output: string;
  work: string;
  keepWork: boolean;
  formats: Array<"deb" | "rpm" | "archlinux" | "tar.gz">;
}

interface VendorRelease {
  version: string;
  build: string;
}

function usage(): never {
  console.error("Usage: npm run port -- <inspect|build> --dmg <ChatGPT.dmg> [--formats deb,rpm,archlinux,tar.gz] [--output <dir>] [--work <dir>] [--keep-work]");
  process.exit(2);
}

function parseArguments(arguments_: string[]): Options {
  const command = arguments_.shift();
  if (command !== "inspect" && command !== "build") usage();
  let dmg = "";
  let output = path.join(repository, "dist");
  let work = path.join(repository, ".work");
  let keepWork = false;
  let formats: Options["formats"] = ["deb", "rpm", "archlinux", "tar.gz"];
  while (arguments_.length) {
    const argument = arguments_.shift();
    if (argument === "--dmg") dmg = arguments_.shift() || "";
    else if (argument === "--output") output = path.resolve(arguments_.shift() || usage());
    else if (argument === "--work") work = path.resolve(arguments_.shift() || usage());
    else if (argument === "--keep-work") keepWork = true;
    else if (argument === "--formats") {
      const requested = (arguments_.shift() || "").split(",");
      const supported = new Set(["deb", "rpm", "archlinux", "tar.gz"]);
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

async function assemblePackageRoot(app: string, packageRoot: string): Promise<void> {
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
  await cp(path.join(runtimeModules, "node_modules"), path.join(installRoot, "resources", "app", "vendor-app", "node_modules"), { recursive: true });
  await cp(path.join(resources, "plugins"), path.join(installRoot, "resources", "plugins"), { recursive: true });
  await cp(path.join(desktop, "launcher.cjs"), path.join(installRoot, "resources", "app", "launcher.cjs"));
  await writeDesktopPackageJson(path.join(installRoot, "resources", "app", "package.json"), vendorApp);

  await cp(path.join(desktop, "packaging", "chatgpt"), path.join(packageRoot, "usr", "bin", "chatgpt"));
  await cp(path.join(desktop, "packaging", "chatgpt.desktop"), path.join(packageRoot, "usr", "share", "applications", "chatgpt.desktop"));
  await cp(path.join(resources, "icon-chatgpt.png"), path.join(packageRoot, "usr", "share", "icons", "hicolor", "512x512", "apps", "chatgpt.png"));

  await chmod(path.join(packageRoot, "usr", "bin", "chatgpt"), 0o755);
  await chmod(path.join(installRoot, "codex-desktop"), 0o755);
  await chmod(path.join(installRoot, "chrome-sandbox"), 0o4755);
}

async function packageFormats(packageRoot: string, output: string, formats: Options["formats"], release: VendorRelease, upstream: UpstreamRelease): Promise<string[]> {
  await mkdir(output, { recursive: true });
  const artifacts: string[] = [];
  for (const format of formats) {
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
    await assemblePackageRoot(app, packageRoot);
    const artifacts = await packageFormats(packageRoot, options.output, options.formats, release, upstream);
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
