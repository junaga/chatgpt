import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Browser Use keeps the upstream plugin and routes it through node_repl", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const codex = await readFile(new URL("../desktop/linux-runtime/bin/codex", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../desktop/launcher.cjs", import.meta.url), "utf8");
  const host = await readFile(new URL("../desktop/linux-runtime/node-repl-host.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(cli, /installLinuxPlugin\(resources, installRoot, "browser"\)/);
  assert.doesNotMatch(cli, /browser-server\.mjs/);
  assert.match(codex, /mcp_servers\.node_repl\.command/);
  assert.match(launcher, /path\.join\(analysisRoot, "codex"\)/);
  assert.match(host, /codex-browser-use/);
  assert.match(host, /8785b5437d98636c3002d3d7e64b98db79c3b66870b1bd3d18dea953a99b1562/);
});

test("the compatibility Browser implementation no longer depends on BROWSER or Playwright", async () => {
  const files = [
    await readFile(new URL("../src/cli.ts", import.meta.url), "utf8"),
    await readFile(new URL("../desktop/linux-runtime/node-repl-host.mjs", import.meta.url), "utf8"),
  ];
  for (const source of files) {
    assert.doesNotMatch(source, /process\.env\.BROWSER/);
    assert.doesNotMatch(source, /playwright-core/);
  }
});

test("the upstream Chrome plugin receives its Linux native messaging host", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const host = await readFile(new URL("../desktop/linux-runtime/chrome-extension-host.mjs", import.meta.url), "utf8");
  const appServer = await readFile(new URL("../desktop/linux-runtime/chrome-app-server.mjs", import.meta.url), "utf8");
  assert.match(cli, /installChromeExtensionHost/);
  assert.match(cli, /"extension-host",\s*"linux"/);
  assert.match(host, /codex-browser-use/);
  assert.match(host, /hehggadaopoacecdllhhajmbjkdcmajg/);
  assert.match(host, /nativeHostProtocolVersion/);
  for (const method of ["ensure", "restart", "openLocalFile", "tabContextAsset/create", "tabContextAsset/finish"]) {
    assert.match(appServer, new RegExp(`codexRuntime/${method}`));
  }
  assert.match(appServer, /app-server", "--listen", "stdio:\/\/"/);
});
