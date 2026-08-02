import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

export interface UpstreamRelease {
  version: string;
  build: string;
  portRevision: number;
  dmgSha256: string;
  bundleId: string;
  appPath: string;
  electron: {
    macos: string;
    linux: string;
  };
  codexCli: string;
  nativeModules: string[];
  nativeArtifacts: Record<string, string[]>;
  skippedSymlinks: Record<string, string>;
  debian: {
    revision: string;
    architecture: "amd64";
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Upstream field ${name} must be a non-empty string`);
  return value;
}

export function validateUpstream(input: unknown): UpstreamRelease {
  if (!input || typeof input !== "object") throw new Error("Upstream metadata must be an object");
  const value = input as Record<string, unknown>;
  const electron = value.electron as Record<string, unknown> | undefined;
  const checksum = requiredString(value.dmgSha256, "dmgSha256");
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Upstream field dmgSha256 must be a lowercase SHA-256");
  if (!electron || typeof electron !== "object") throw new Error("Upstream field electron must be an object");
  if (!Array.isArray(value.nativeModules) || value.nativeModules.some(item => typeof item !== "string")) {
    throw new Error("Upstream field nativeModules must be an array of strings");
  }
  if (!value.skippedSymlinks || typeof value.skippedSymlinks !== "object" || Array.isArray(value.skippedSymlinks)) {
    throw new Error("Upstream field skippedSymlinks must be an object");
  }
  if (!value.nativeArtifacts || typeof value.nativeArtifacts !== "object" || Array.isArray(value.nativeArtifacts)) {
    throw new Error("Upstream field nativeArtifacts must be an object");
  }
  const nativeArtifacts = value.nativeArtifacts as Record<string, unknown>;
  for (const module of value.nativeModules) {
    const artifacts = nativeArtifacts[module];
    if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.some(item => typeof item !== "string")) {
      throw new Error(`Upstream nativeArtifacts.${module} must be a non-empty array of strings`);
    }
  }
  const skippedSymlinks = value.skippedSymlinks as Record<string, unknown>;
  if (Object.values(skippedSymlinks).some(target => typeof target !== "string")) {
    throw new Error("Upstream skippedSymlink targets must be strings");
  }
  const debian = value.debian as Record<string, unknown> | undefined;
  if (!debian || typeof debian !== "object") throw new Error("Upstream field debian must be an object");
  if (debian.architecture !== "amd64") throw new Error("Only Debian amd64 is currently supported");
  if (!Number.isInteger(value.portRevision) || Number(value.portRevision) < 1) {
    throw new Error("Upstream field portRevision must be a positive integer");
  }
  return {
    version: requiredString(value.version, "version"),
    build: requiredString(value.build, "build"),
    portRevision: Number(value.portRevision),
    dmgSha256: checksum,
    bundleId: requiredString(value.bundleId, "bundleId"),
    appPath: requiredString(value.appPath, "appPath"),
    electron: {
      macos: requiredString(electron.macos, "electron.macos"),
      linux: requiredString(electron.linux, "electron.linux"),
    },
    codexCli: requiredString(value.codexCli, "codexCli"),
    nativeModules: [...value.nativeModules],
    nativeArtifacts: nativeArtifacts as Record<string, string[]>,
    skippedSymlinks: skippedSymlinks as Record<string, string>,
    debian: {
      revision: requiredString(debian.revision, "debian.revision"),
      architecture: "amd64",
    },
  };
}

export async function loadUpstream(file: string): Promise<UpstreamRelease> {
  return validateUpstream(JSON.parse(await readFile(file, "utf8")));
}

export async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
