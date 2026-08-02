#!/usr/bin/env node
import { spawn, type StdioOptions } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, cp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadUpstream, sha256, type UpstreamRelease } from "./upstream.ts";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstreamFile = path.join(repository, "upstream.json");
const desktop = path.join(repository, "desktop");

interface Options {
  command: "inspect" | "build";
  dmg: string;
  output: string;
  work: string;
  keepWork: boolean;
}

function usage(): never {
  console.error("Usage: npm run port -- <inspect|build> --dmg <ChatGPT.dmg> [--output <dir>] [--work <dir>] [--keep-work]");
  process.exit(2);
}

function parseArguments(arguments_: string[]): Options {
  const command = arguments_.shift();
  if (command !== "inspect" && command !== "build") usage();
  let dmg = "";
  let output = path.join(repository, "dist");
  let work = path.join(repository, ".work");
  let keepWork = false;
  while (arguments_.length) {
    const argument = arguments_.shift();
    if (argument === "--dmg") dmg = arguments_.shift() || "";
    else if (argument === "--output") output = path.resolve(arguments_.shift() || usage());
    else if (argument === "--work") work = path.resolve(arguments_.shift() || usage());
    else if (argument === "--keep-work") keepWork = true;
    else usage();
  }
  if (!dmg) usage();
  return { command, dmg: path.resolve(dmg), output, work, keepWork };
}

interface RunOptions {
  cwd?: string;
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
    const child = spawn(command, arguments_, { cwd: options.cwd, stdio });
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

async function validateExtractedApp(app: string, upstream: UpstreamRelease): Promise<void> {
  const resources = path.join(app, "Contents", "Resources");
  const packageJson = JSON.parse(await readFile(path.join(resources, "app.asar.extracted", "package.json"), "utf8"));
  if (packageJson.version !== upstream.version) {
    throw new Error(`Renderer version ${packageJson.version} does not match supported upstream ${upstream.version}`);
  }
  if (String(packageJson.codexBuildNumber) !== upstream.build) {
    throw new Error(`Renderer build ${packageJson.codexBuildNumber} does not match supported upstream ${upstream.build}`);
  }
  for (const module of upstream.nativeModules) {
    await requireFile(path.join(resources, "app.asar.extracted", "node_modules", module, "package.json"), `Native module ${module}`);
  }
  await requireFile(path.join(resources, "plugins"), "Bundled plugins");
  await requireFile(path.join(resources, "icon-chatgpt.png"), "Application icon");
}

async function extract(dmg: string, root: string, upstream: UpstreamRelease): Promise<string> {
  const extracted = path.join(root, "dmg");
  await mkdir(extracted, { recursive: true });
  const extraction = await run("7z", ["x", dmg, `-o${extracted}`, "-y"], {
    capture: true,
    allowedExitCodes: [0, 2],
  });
  const app = path.join(extracted, upstream.appPath);
  if (extraction.code === 2) {
    const errors = extraction.output.split("\n").filter(line => line.startsWith("ERROR:"));
    const expected = new Set(Object.keys(upstream.skippedSymlinks).map(link => `${upstream.appPath}/${link}`));
    const actual = new Set<string>();
    for (const error of errors) {
      const match = error.match(/^ERROR: Dangerous link path was ignored : (.+?) : /);
      if (!match || !expected.has(match[1])) throw new Error(`Unexpected DMG extraction error: ${error}`);
      actual.add(match[1]);
    }
    if (actual.size !== expected.size) throw new Error("DMG extraction did not report the expected skipped symlinks");
  }
  for (const [relativeLink, target] of Object.entries(upstream.skippedSymlinks)) {
    const link = path.join(app, relativeLink);
    const resolvedTarget = path.resolve(path.dirname(link), target);
    if (!resolvedTarget.startsWith(`${app}${path.sep}`)) throw new Error(`Unsafe symlink target in upstream metadata: ${relativeLink}`);
    await requireFile(resolvedTarget, `Symlink target for ${relativeLink}`);
    await mkdir(path.dirname(link), { recursive: true });
    try {
      await access(link);
    } catch {
      await symlink(target, link);
    }
  }
  const resources = path.join(app, "Contents", "Resources");
  await requireFile(path.join(resources, "app.asar"), "Electron ASAR");
  const vendorApp = path.join(resources, "app.asar.extracted");
  const asar = path.join(repository, "node_modules", ".bin", "asar");
  await run(asar, ["extract", path.join(resources, "app.asar"), vendorApp]);
  await validateExtractedApp(app, upstream);
  return app;
}

async function rebuildNativeModules(app: string, upstream: UpstreamRelease): Promise<void> {
  const vendorApp = path.join(app, "Contents", "Resources", "app.asar.extracted");
  const rebuild = path.join(desktop, "node_modules", ".bin", "electron-rebuild");
  await requireFile(rebuild, "electron-rebuild");
  await run(rebuild, [
    "--force",
    "--version", upstream.electron.linux,
    "--arch", "x64",
    "--platform", "linux",
    "--module-dir", desktop,
    "--only", upstream.nativeModules.join(","),
  ]);
  for (const module of upstream.nativeModules) {
    for (const artifact of upstream.nativeArtifacts[module]) {
      const source = path.join(desktop, "node_modules", module, artifact);
      const destination = path.join(vendorApp, "node_modules", module, artifact);
      await requireFile(source, `Rebuilt artifact ${module}/${artifact}`);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination);
    }
  }
}

async function writeDesktopPackageJson(destination: string, upstream: UpstreamRelease): Promise<void> {
  const source = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  source.version = upstream.version;
  source.codexBuildNumber = upstream.build;
  source.dependencies.electron = upstream.electron.linux;
  await writeFile(destination, `${JSON.stringify(source, null, 2)}\n`);
}

async function assembleDeb(app: string, buildRoot: string, output: string, upstream: UpstreamRelease): Promise<string> {
  const packageVersion = `${upstream.version}-${upstream.debian.revision}`;
  const packageBase = `codex-desktop-linux_${packageVersion}_${upstream.debian.architecture}`;
  const packageRoot = path.join(buildRoot, packageBase);
  const installRoot = path.join(packageRoot, "opt", "codex-desktop-linux");
  const resources = path.join(app, "Contents", "Resources");
  await Promise.all([
    mkdir(path.join(packageRoot, "DEBIAN"), { recursive: true }),
    mkdir(path.join(installRoot, "resources", "app"), { recursive: true }),
    mkdir(path.join(packageRoot, "usr", "bin"), { recursive: true }),
    mkdir(path.join(packageRoot, "usr", "share", "applications"), { recursive: true }),
    mkdir(path.join(packageRoot, "usr", "share", "icons", "hicolor", "512x512", "apps"), { recursive: true }),
    mkdir(output, { recursive: true }),
  ]);

  await cp(path.join(desktop, "node_modules", "electron", "dist"), installRoot, { recursive: true });
  await rename(path.join(installRoot, "electron"), path.join(installRoot, "codex-desktop"));
  await cp(path.join(resources, "app.asar.extracted"), path.join(installRoot, "resources", "app", "vendor-app"), { recursive: true });
  await cp(path.join(resources, "plugins"), path.join(installRoot, "resources", "plugins"), { recursive: true });
  await cp(path.join(desktop, "launcher.cjs"), path.join(installRoot, "resources", "app", "launcher.cjs"));
  await writeDesktopPackageJson(path.join(installRoot, "resources", "app", "package.json"), upstream);

  const control = (await readFile(path.join(desktop, "packaging", "control"), "utf8"))
    .replace(/^Version: .*$/m, `Version: ${packageVersion}`)
    .replace(/^Architecture: .*$/m, `Architecture: ${upstream.debian.architecture}`);
  await writeFile(path.join(packageRoot, "DEBIAN", "control"), control);
  await cp(path.join(desktop, "packaging", "codex-desktop"), path.join(packageRoot, "usr", "bin", "codex-desktop"));
  await cp(path.join(desktop, "packaging", "codex-desktop.desktop"), path.join(packageRoot, "usr", "share", "applications", "codex-desktop.desktop"));
  await cp(path.join(resources, "icon-chatgpt.png"), path.join(packageRoot, "usr", "share", "icons", "hicolor", "512x512", "apps", "codex-desktop.png"));

  await chmod(path.join(packageRoot, "usr", "bin", "codex-desktop"), 0o755);
  await chmod(path.join(installRoot, "codex-desktop"), 0o755);
  await chmod(path.join(installRoot, "chrome-sandbox"), 0o4755);
  const deb = path.join(output, `${packageBase}.deb`);
  await run("dpkg-deb", ["--root-owner-group", "-Zgzip", "-z1", "--build", packageRoot, deb]);
  return deb;
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
  console.log(`Supported upstream: ${upstream.version} (build ${upstream.build}, port revision ${upstream.portRevision})`);
  console.log(`DMG SHA-256: ${checksum}`);
  if (options.command === "inspect") return;
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Building currently requires Linux x86-64");

  console.log("Installing pinned Linux build dependencies…");
  await run("npm", ["ci", "--prefix", desktop]);

  const workRoot = path.join(options.work, checksum.slice(0, 16));
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
  try {
    const app = await extract(options.dmg, workRoot, upstream);
    await rebuildNativeModules(app, upstream);
    const deb = await assembleDeb(app, path.join(workRoot, "package"), options.output, upstream);
    const report = {
      createdAt: new Date().toISOString(),
      upstreamVersion: upstream.version,
      buildNumber: upstream.build,
      portRevision: upstream.portRevision,
      dmgSha256: checksum,
      deb: path.basename(deb),
      debSha256: await sha256(deb),
      electron: upstream.electron.linux,
      nativeModules: upstream.nativeModules,
    };
    await writeFile(`${deb}.build.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Built ${deb}`);
    console.log(`SHA-256: ${report.debSha256}`);
  } finally {
    if (!options.keepWork) await rm(workRoot, { recursive: true, force: true });
    else console.log(`Kept work directory: ${workRoot}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
