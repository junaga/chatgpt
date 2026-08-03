import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The packaged runtime is intentionally plain JavaScript so Electron can run it directly.
// @ts-expect-error No declaration file is shipped for the packaged runtime module.
import { browserEnvironmentCandidates, createBrowserServer, findBrowserExecutable } from "../desktop/linux-runtime/browser-server.mjs";

test("BROWSER is the first Chromium discovery entry point", async () => {
  assert.deepEqual(browserEnvironmentCandidates("chromium:%s:firefox"), ["chromium", "firefox"]);

  const directory = await mkdtemp(path.join(os.tmpdir(), "chatgpt-browser-test-"));
  const chromium = path.join(directory, "chromium");
  try {
    await writeFile(chromium, "#!/bin/sh\nexit 0\n");
    await chmod(chromium, 0o755);
    assert.deepEqual(
      await findBrowserExecutable({ BROWSER: "chromium", PATH: directory }),
      { path: chromium, source: "BROWSER" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser MCP advertises tools and forwards calls", async () => {
  const calls: Array<{ name: string; arguments_: Record<string, unknown> }> = [];
  const server = createBrowserServer({
    async call(name: string, arguments_: Record<string, unknown>) {
      calls.push({ name, arguments_ });
      return { content: [{ type: "text", text: "ok" }] };
    },
  });

  const initialized = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(initialized.result.serverInfo.name, "chatgpt-linux-browser");

  const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    listed.result.tools.map((tool: { name: string }) => tool.name),
    ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_screenshot", "browser_tabs"],
  );

  const called = await server.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "browser_open", arguments: { url: "https://example.com" } },
  });
  assert.equal(called.result.content[0].text, "ok");
  assert.deepEqual(calls, [{ name: "browser_open", arguments_: { url: "https://example.com" } }]);
});
