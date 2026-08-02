import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface PortManifest {
  upstreamVersion: string;
  buildNumber: string;
  dmgSha256: string;
  bundleId: string;
  appRelativePath: string;
  electron: {
    upstream: string;
    linuxCompatibility: string;
  };
  codexCli: string;
  nativeModules: string[];
  nativeArtifacts: Record<string, string[]>;
  skippedSymlinks: Record<string, string>;
  debianRevision: string;
  architecture: "amd64";
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Manifest field ${name} must be a non-empty string`);
  return value;
}

export function validateManifest(input: unknown): PortManifest {
  if (!input || typeof input !== "object") throw new Error("Manifest must be an object");
  const value = input as Record<string, unknown>;
  const electron = value.electron as Record<string, unknown> | undefined;
  const checksum = requiredString(value.dmgSha256, "dmgSha256");
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Manifest field dmgSha256 must be a lowercase SHA-256");
  if (!electron || typeof electron !== "object") throw new Error("Manifest field electron must be an object");
  if (!Array.isArray(value.nativeModules) || value.nativeModules.some(item => typeof item !== "string")) {
    throw new Error("Manifest field nativeModules must be an array of strings");
  }
  if (!value.skippedSymlinks || typeof value.skippedSymlinks !== "object" || Array.isArray(value.skippedSymlinks)) {
    throw new Error("Manifest field skippedSymlinks must be an object");
  }
  if (!value.nativeArtifacts || typeof value.nativeArtifacts !== "object" || Array.isArray(value.nativeArtifacts)) {
    throw new Error("Manifest field nativeArtifacts must be an object");
  }
  const nativeArtifacts = value.nativeArtifacts as Record<string, unknown>;
  for (const module of value.nativeModules) {
    const artifacts = nativeArtifacts[module];
    if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.some(item => typeof item !== "string")) {
      throw new Error(`Manifest nativeArtifacts.${module} must be a non-empty array of strings`);
    }
  }
  const skippedSymlinks = value.skippedSymlinks as Record<string, unknown>;
  if (Object.values(skippedSymlinks).some(target => typeof target !== "string")) {
    throw new Error("Manifest skippedSymlink targets must be strings");
  }
  if (value.architecture !== "amd64") throw new Error("Only Debian amd64 is currently supported");
  return {
    upstreamVersion: requiredString(value.upstreamVersion, "upstreamVersion"),
    buildNumber: requiredString(value.buildNumber, "buildNumber"),
    dmgSha256: checksum,
    bundleId: requiredString(value.bundleId, "bundleId"),
    appRelativePath: requiredString(value.appRelativePath, "appRelativePath"),
    electron: {
      upstream: requiredString(electron.upstream, "electron.upstream"),
      linuxCompatibility: requiredString(electron.linuxCompatibility, "electron.linuxCompatibility"),
    },
    codexCli: requiredString(value.codexCli, "codexCli"),
    nativeModules: [...value.nativeModules],
    nativeArtifacts: nativeArtifacts as Record<string, string[]>,
    skippedSymlinks: skippedSymlinks as Record<string, string>,
    debianRevision: requiredString(value.debianRevision, "debianRevision"),
    architecture: "amd64",
  };
}

export async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function findManifest(manifestsDirectory: string, checksum: string): Promise<PortManifest> {
  const names = (await readdir(manifestsDirectory)).filter(name => name.endsWith(".json")).sort();
  for (const name of names) {
    const raw = JSON.parse(await readFile(path.join(manifestsDirectory, name), "utf8"));
    const manifest = validateManifest(raw);
    if (manifest.dmgSha256 === checksum) return manifest;
  }
  throw new Error(`Unsupported DMG SHA-256: ${checksum}`);
}
