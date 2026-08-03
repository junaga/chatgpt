import { createHash } from "node:crypto";

export const NODE_REPL_SOURCE_HEADER = "// Node-based kernel for node_repl.";
export const NODE_REPL_SOURCE_SHA256 = "8668744dbcd5dddc94bb2236156094076991799b344eb4a305ea5740c269f85e";

interface SourceBoundary {
  filename: string;
  marker: string;
}

const sourceBoundaries: SourceBoundary[] = [
  { filename: "diagnostics.js", marker: "diagnostics.jsconst redactedDiagnosticSource" },
  { filename: "privileged-node-repl.js", marker: "privileged-node-repl.js// Trusted-only bridge" },
  { filename: "privileged-node-repl-config.js", marker: "privileged-node-repl-config.jsfunction createPrivileged" },
  { filename: "realmChecks.js", marker: "realmChecks.js/**" },
  { filename: "meriyah.umd.min.js", marker: "meriyah.umd.min.js/*!" },
  { filename: "tracing.js", marker: "tracing.jsconst { AsyncLocalStorage" },
  { filename: "trusted-process-facade.js", marker: "trusted-process-facade.js// `node_repl`" },
];

export interface NodeReplSources {
  source: Buffer;
  files: Map<string, Buffer>;
}

function uniqueIndex(source: string, marker: string): number {
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`node_repl source boundary is missing: ${marker}`);
  if (source.indexOf(marker, index + marker.length) >= 0) {
    throw new Error(`node_repl source boundary is ambiguous: ${marker}`);
  }
  return index;
}

/**
 * The signed macOS executable contains its Node kernel as a pair of identical,
 * NUL-terminated UTF-8 blobs. Extract the first copy and restore the virtual
 * source files that the executable normally materializes at runtime.
 */
export function extractNodeReplSources(
  executable: Buffer,
  expectedSha256: string | null = NODE_REPL_SOURCE_SHA256,
): NodeReplSources {
  const header = Buffer.from(NODE_REPL_SOURCE_HEADER);
  const start = executable.indexOf(header);
  if (start < 0) throw new Error("node_repl embedded kernel source was not found");
  const end = executable.indexOf(0, start);
  if (end < 0) throw new Error("node_repl embedded kernel source is not NUL-terminated");

  const source = executable.subarray(start, end);
  const digest = createHash("sha256").update(source).digest("hex");
  if (expectedSha256 != null && digest !== expectedSha256) {
    throw new Error(`Unexpected node_repl embedded source SHA-256: ${digest}`);
  }

  const text = source.toString("utf8");
  const located = sourceBoundaries.map(boundary => ({
    ...boundary,
    index: uniqueIndex(text, boundary.marker),
  }));
  for (let index = 1; index < located.length; index += 1) {
    if (located[index - 1].index >= located[index].index) {
      throw new Error("node_repl embedded source files are out of order");
    }
  }

  const files = new Map<string, Buffer>();
  let previousStart = 0;
  let previousFilename = "kernel.js";
  for (const boundary of located) {
    files.set(previousFilename, Buffer.from(text.slice(previousStart, boundary.index)));
    previousFilename = boundary.filename;
    previousStart = boundary.index + boundary.filename.length;
  }
  files.set(previousFilename, Buffer.from(text.slice(previousStart)));
  return { source: Buffer.from(source), files };
}

export function expectedNodeReplSourceFiles(): string[] {
  return ["kernel.js", ...sourceBoundaries.map(boundary => boundary.filename)];
}
