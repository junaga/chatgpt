import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

export interface UpstreamRelease {
  portRevision: number;
  dmgSha256: string;
  appPath: string;
  nativeArtifacts: Record<string, string[]>;
  acceptedExtractionWarnings: string[];
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Upstream field ${name} must be a non-empty string`);
  return value;
}

export function validateUpstream(input: unknown): UpstreamRelease {
  if (!input || typeof input !== "object") throw new Error("Upstream metadata must be an object");
  const value = input as Record<string, unknown>;
  const checksum = requiredString(value.dmgSha256, "dmgSha256");
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Upstream field dmgSha256 must be a lowercase SHA-256");
  if (!value.nativeArtifacts || typeof value.nativeArtifacts !== "object" || Array.isArray(value.nativeArtifacts)) {
    throw new Error("Upstream field nativeArtifacts must be an object");
  }
  const nativeArtifacts = value.nativeArtifacts as Record<string, unknown>;
  for (const [module, artifacts] of Object.entries(nativeArtifacts)) {
    if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.some(item => typeof item !== "string")) {
      throw new Error(`Upstream nativeArtifacts.${module} must be a non-empty array of strings`);
    }
  }
  if (Object.keys(nativeArtifacts).length === 0) throw new Error("Upstream nativeArtifacts must not be empty");
  if (!Array.isArray(value.acceptedExtractionWarnings) || value.acceptedExtractionWarnings.some(item => typeof item !== "string")) {
    throw new Error("Upstream field acceptedExtractionWarnings must be an array of strings");
  }
  if (!Number.isInteger(value.portRevision) || Number(value.portRevision) < 1) {
    throw new Error("Upstream field portRevision must be a positive integer");
  }
  return {
    portRevision: Number(value.portRevision),
    dmgSha256: checksum,
    appPath: requiredString(value.appPath, "appPath"),
    nativeArtifacts: nativeArtifacts as Record<string, string[]>,
    acceptedExtractionWarnings: [...value.acceptedExtractionWarnings],
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
