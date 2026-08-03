#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function skyLinuxBinary({ arch = process.arch, runtimeDirectory = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  const filename = arch === "arm64" ? "sky_linux_arm64" : arch === "x64" ? "sky_linux_x64" : null;
  if (!filename) throw new Error(`Unsupported Linux input architecture: ${arch}`);
  return path.resolve(runtimeDirectory, "../cua_node/lib/node_modules/@oai/sky/bin/linux", filename);
}

export function invokeSky(command, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary || skyLinuxBinary(options), [command], {
      env: options.environment || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Sky input exited with ${code}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const action = process.argv[2];
  if (action !== "paste") throw new Error(`Unsupported Linux input action: ${action}`);
  await invokeSky("press_key", { key: "ctrl+v" });
}
