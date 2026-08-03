import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

// @ts-expect-error Packaged runtime modules intentionally ship as plain JavaScript.
import { allowedAuthenticatedFetchUrl, allowedNativePipe, chatgptAccountIdFromToken, kernelLaunch, NodeReplMcpServer, NODE_REPL_TOOLS, NodeReplRuntime, resolveCodexTomlPath } from "../desktop/linux-runtime/node-repl-host.mjs";

test("node_repl publishes the upstream three-tool contract", async () => {
  const calls: unknown[] = [];
  const runtime = {
    execute: async (...args: unknown[]) => { calls.push(["execute", ...args]); return { content: [{ type: "text", text: "ok" }] }; },
    reset: async () => true,
    addModuleDirectory: async (directory: string) => { calls.push(["add", directory]); return true; },
  };
  const server = new NodeReplMcpServer(runtime);
  const listed = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ["js", "js_reset", "js_add_node_module_dir"]);
  assert.equal(NODE_REPL_TOOLS[0].inputSchema.properties.code.minLength, 1);
  const called = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "js", arguments: { code: "1 + 1" }, _meta: { "codex/sandbox-state-meta": { filesystem: "read-only" } } } });
  assert.equal(called.result.content[0].text, "ok");
  assert.deepEqual(calls, [["execute", { code: "1 + 1" }, { "codex/sandbox-state-meta": { filesystem: "read-only" } }]]);
});

test("kernel launch applies the supplied Codex sandbox state", () => {
  const launch = kernelLaunch({ codexPath: "/usr/bin/codex", nodePath: "/opt/chatgpt/node", kernelPath: "/opt/chatgpt/kernel.js", runtimeRoot: "/opt/chatgpt/cua", workingDirectory: "/work", sandboxState: { network: false } });
  assert.equal(launch.command, "/usr/bin/codex");
  assert.deepEqual(launch.args.slice(0, 7), ["sandbox", "--sandbox-state-json", '{"network":false}', "--sandbox-state-readable-root", "/opt/chatgpt/cua", "-C", "/work"]);
  assert.ok(launch.args.includes("--experimental-vm-modules"));
});

test("native pipes are restricted to browser-use sockets", () => {
  assert.equal(allowedNativePipe("/tmp/codex-browser-use/123.sock"), true);
  assert.equal(allowedNativePipe("/tmp/codex-browser-use-123/socket"), false);
  assert.equal(allowedNativePipe("/tmp/codex-browser-use"), false);
  assert.equal(allowedNativePipe("/run/user/1000/chatgpt-auth", "/run/user/1000/chatgpt-auth"), true);
  assert.equal(allowedNativePipe("/run/user/1000/ssh-agent"), false);
  assert.equal(allowedNativePipe(path.relative(process.cwd(), "/tmp/codex-browser-use")), false);
});

test("browser TOML paths cannot escape CODEX_HOME", () => {
  assert.equal(resolveCodexTomlPath("/home/test/.codex", "browser/config.toml"), "/home/test/.codex/browser/config.toml");
  assert.throws(() => resolveCodexTomlPath("/home/test/.codex", "../config.toml"), /inside CODEX_HOME/);
  assert.throws(() => resolveCodexTomlPath("/home/test/.codex", "browser/config.json"), /end in \.toml/);
});

test("authenticated Browser requests use Codex auth without exposing it to other origins", async () => {
  const accountId = "account-test";
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  const token = `header.${payload}.signature`;
  assert.equal(chatgptAccountIdFromToken(token), accountId);
  assert.equal(allowedAuthenticatedFetchUrl("https://chatgpt.com/backend-api/aura/site_status?origin=https%3A%2F%2Fexample.com"), true);
  assert.equal(allowedAuthenticatedFetchUrl("https://chatgpt.com.evil.example/backend-api/aura/site_status"), false);
  assert.equal(allowedAuthenticatedFetchUrl("http://chatgpt.com/backend-api/aura/site_status"), false);

  const appServerCalls: unknown[] = [];
  const fetchCalls: unknown[] = [];
  const output: string[] = [];
  const runtime = new NodeReplRuntime({
    configClient: {
      request: async (...args: unknown[]) => {
        appServerCalls.push(args);
        return { authMethod: "chatgpt", authToken: token, requiresOpenaiAuth: true };
      },
    },
    fetchImpl: async (url: string, init: RequestInit) => {
      fetchCalls.push([url, init]);
      return new Response('{"allowed":true}', { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  runtime.child = { stdin: { write: (value: string) => output.push(value) } };
  await runtime.handleAuthenticatedFetch({
    id: "fetch-1",
    request: {
      method: "GET",
      url: "https://chatgpt.com/backend-api/aura/site_status?origin=https%3A%2F%2Fexample.com",
      headers: [],
    },
  });

  assert.deepEqual(appServerCalls, [["getAuthStatus", { includeToken: true, refreshToken: false }]]);
  assert.equal(fetchCalls.length, 1);
  const [, init] = fetchCalls[0] as [string, RequestInit];
  const headers = init.headers as Headers;
  assert.equal(headers.get("authorization"), `Bearer ${token}`);
  assert.equal(headers.get("chatgpt-account-id"), accountId);
  const result = JSON.parse(output.join(""));
  assert.equal(result.ok, true);
  assert.equal(Buffer.from(result.response.body_base64, "base64").toString("utf8"), '{"allowed":true}');
});
