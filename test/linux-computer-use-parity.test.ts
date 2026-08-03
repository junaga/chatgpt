import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Packaged plugin code is intentionally plain JavaScript.
// @ts-expect-error no declaration file is shipped for the plugin wrapper
import { createClient } from "../desktop/linux-plugins/computer-use/scripts/computer-use-client.mjs";

const runtimeGlobals = globalThis as typeof globalThis & { nodeRepl?: unknown };

test("Linux Computer Use advertises only the exact node_repl surface and keeps the full policy", async () => {
  const [manifestText, guide] = await Promise.all([
    readFile(new URL("../desktop/linux-plugins/computer-use/.codex-plugin/plugin.json", import.meta.url), "utf8"),
    readFile(new URL("../desktop/linux-plugins/computer-use/.codex-plugin/computer-use-node-repl.md", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.mcpServers, undefined);
  assert.match(guide, /target: "linux"/);
  assert.match(guide, /# Computer Use Confirmations Policy/);
  assert.match(guide, /## Computer Use Confirmation Behavior Guidelines/);
});

test("Linux sky client exposes the upstream window method names", () => {
  const client = createClient({ transport: { request() {}, close() {} } });
  assert.equal(client.target, "linux");
  assert.deepEqual(
    [
      "click", "drag", "get_app_state", "list_apps", "perform_secondary_action",
      "press_key", "scroll", "select_text", "set_value", "type_text",
    ].filter(name => typeof client[name] === "function"),
    [
      "click", "drag", "get_app_state", "list_apps", "perform_secondary_action",
      "press_key", "scroll", "select_text", "set_value", "type_text",
    ],
  );
});

test("Linux sky client preserves disableDiff and semantic action arguments", async t => {
  const original = runtimeGlobals.nodeRepl;
  t.after(() => { runtimeGlobals.nodeRepl = original; });
  const approvals: unknown[] = [];
  runtimeGlobals.nodeRepl = {
    async createElicitation(request: unknown) {
      approvals.push(request);
      return { action: "accept" };
    },
    async withSuspendedTimeout(operation: () => Promise<unknown>) { return await operation(); },
    setResponseMeta() {},
  };
  const calls: Array<{method: string, params: unknown}> = [];
  const transport = {
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === "get_app_state") {
        return { type: "app_state", value: { app: "Editor", screenshot: null, text: "tree" } };
      }
      return { type: "action_complete" };
    },
    close() {},
  };
  const client = createClient({ transport });
  assert.deepEqual(
    await client.get_app_state({ app: "Editor", disableDiff: true }),
    { app: "Editor", screenshot: null, text: "tree" },
  );
  await client.select_text({
    app: "Editor",
    element_index: 7,
    text: "hello",
    selection_type: "cursor_after",
  });
  assert.equal(approvals.length, 1, "approval is reused for the app during this client session");
  assert.deepEqual(calls, [
    { method: "get_app_state", params: { app: "Editor", disableDiff: true } },
    {
      method: "action",
      params: {
        kind: "select_text",
        app: "Editor",
        element_index: 7,
        text: "hello",
        selection_type: "cursor_after",
      },
    },
  ]);
});

test("Linux sky client requires per-app elicitation before exposing app content", async t => {
  const original = runtimeGlobals.nodeRepl;
  t.after(() => { runtimeGlobals.nodeRepl = original; });
  runtimeGlobals.nodeRepl = {
    async createElicitation() { return { action: "decline" }; },
    async withSuspendedTimeout(operation: () => Promise<unknown>) { return await operation(); },
    setResponseMeta() {},
  };
  let requests = 0;
  const client = createClient({
    transport: {
      async request() { requests += 1; },
      close() {},
    },
  });
  await assert.rejects(client.get_app_state({ app: "Secrets" }), /was not approved/);
  assert.equal(requests, 0);
});

test("Linux sky client rejects accessors and cannot have its action kind overridden", async t => {
  const original = runtimeGlobals.nodeRepl;
  t.after(() => { runtimeGlobals.nodeRepl = original; });
  runtimeGlobals.nodeRepl = {
    async createElicitation() { return { action: "accept" }; },
    async withSuspendedTimeout(operation: () => Promise<unknown>) { return await operation(); },
    setResponseMeta() {},
  };
  const calls: Array<{method: string, params: unknown}> = [];
  const client = createClient({
    transport: {
      async request(method: string, params: unknown) {
        calls.push({ method, params });
        return { type: "action_complete" };
      },
      close() {},
    },
  });

  await client.click({ app: "Editor", element_index: 1, kind: "drag" });
  assert.deepEqual(calls[0], {
    method: "action",
    params: { app: "Editor", element_index: 1, kind: "click" },
  });

  const input = Object.create(null, {
    app: { enumerable: true, get: () => "Editor" },
  });
  await assert.rejects(client.get_app_state(input), /plain data property/);
});

test("Linux sky client combines AT-SPI state with bundled X11 Sky capture and fallback", async t => {
  const original = runtimeGlobals.nodeRepl;
  t.after(() => { runtimeGlobals.nodeRepl = original; });
  runtimeGlobals.nodeRepl = {
    async createElicitation() { return { action: "accept" }; },
    async withSuspendedTimeout(operation: () => Promise<unknown>) { return await operation(); },
    setResponseMeta() {},
  };
  const rawCalls: Array<{method: string, input?: unknown}> = [];
  const rawClient = {
    async get_screenshot() {
      rawCalls.push({ method: "get_screenshot" });
      return [{ filepath: "/tmp/linux-sky.jpg" }];
    },
    async click(input: unknown) { rawCalls.push({ method: "click", input }); },
  };
  const client = createClient({
    environment: { DISPLAY: ":1", XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "" },
    rawClient,
    transport: {
      async request(method: string) {
        if (method === "get_app_state") {
          return { type: "app_state", value: { app: "Editor", screenshot: null, text: "tree" } };
        }
        throw Object.assign(new Error("raw input required"), {
          code: "noActiveSession",
          targetBounds: { x: 10, y: 20, width: 40, height: 20 },
        });
      },
      close() {},
    },
  });

  const state = await client.get_app_state({ app: "Editor" });
  assert.equal(state.screenshot.url, "file:///tmp/linux-sky.jpg");
  await client.click({ app: "Editor", element_index: 8 });
  assert.deepEqual(rawCalls, [
    { method: "get_screenshot" },
    { method: "click", input: { x: 30, y: 30 } },
  ]);
});
