import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  expectedNodeReplSourceFiles,
  extractNodeReplSources,
  NODE_REPL_SOURCE_HEADER,
} from "../src/node-repl-assets.ts";

const parts: Array<[string, string]> = [
  ["kernel.js", `${NODE_REPL_SOURCE_HEADER}\nconst kernel = true;\n`],
  ["diagnostics.js", "const redactedDiagnosticSource = true;\n"],
  ["privileged-node-repl.js", "// Trusted-only bridge\nconst bridge = true;\n"],
  ["privileged-node-repl-config.js", "function createPrivileged() {}\n"],
  ["realmChecks.js", "/** realm checks */\n"],
  ["meriyah.umd.min.js", "/*! Meriyah */\n"],
  ["tracing.js", "const { AsyncLocalStorage } = require('node:async_hooks');\n"],
  ["trusted-process-facade.js", "// `node_repl` facade\n"],
];

function syntheticExecutable(): { executable: Buffer; digest: string } {
  const joined = parts.map(([filename, source], index) => index === 0 ? source : `${filename}${source}`).join("");
  return {
    executable: Buffer.concat([Buffer.from("native-prefix\0"), Buffer.from(joined), Buffer.from("\0native-suffix")]),
    digest: createHash("sha256").update(joined).digest("hex"),
  };
}

test("restores every virtual source file from the embedded kernel", () => {
  const { executable, digest } = syntheticExecutable();
  const extracted = extractNodeReplSources(executable, digest);
  assert.deepEqual([...extracted.files], parts.map(([filename, source]) => [filename, Buffer.from(source)]));
  assert.deepEqual(expectedNodeReplSourceFiles(), parts.map(([filename]) => filename));
});

test("rejects changed or incomplete embedded kernels", () => {
  const { executable } = syntheticExecutable();
  assert.throws(() => extractNodeReplSources(executable, "0".repeat(64)), /Unexpected node_repl/);
  assert.throws(
    () => extractNodeReplSources(Buffer.from(`${NODE_REPL_SOURCE_HEADER}\n\0`), null),
    /source boundary is missing/,
  );
});
