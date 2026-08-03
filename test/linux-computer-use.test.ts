import assert from "node:assert/strict";
import test from "node:test";

// The packaged runtime is intentionally plain JavaScript so Electron can run it directly.
// @ts-expect-error No declaration file is shipped for the packaged runtime module.
import { ComputerUseController, createComputerUseServer, validateComputerArguments } from "../desktop/linux-runtime/computer-use-server.mjs";

test("computer-use inputs are reduced to the documented Linux API", () => {
  assert.deepEqual(
    validateComputerArguments("computer_click", { x: 12, y: 30, mouse_button: "left", ignored: "value" }),
    { x: 12, y: 30, mouse_button: "left" },
  );
  assert.deepEqual(validateComputerArguments("computer_type_text", { text: "hello" }), { text: "hello" });
  assert.throws(() => validateComputerArguments("computer_scroll", { direction: "diagonal" }), /not supported/);
  assert.throws(() => validateComputerArguments("computer_click", { x: "12", y: 30 }), /finite number/);
});

test("computer-use refuses to claim native Wayland support", async () => {
  const controller = new ComputerUseController({
    environment: {
      CHATGPT_SKY_LINUX_BIN: "/unused/sky_linux_x64",
      DISPLAY: ":1",
      XDG_SESSION_TYPE: "wayland",
    },
    platform: "linux",
  });
  await assert.rejects(controller.call("computer_click", { x: 1, y: 2 }), /Native Wayland Computer Use is not available/);
});

test("computer-use MCP exposes only screenshot and input tools", async () => {
  const calls: Array<{ name: string; arguments_: Record<string, unknown> }> = [];
  const server = createComputerUseServer({
    async call(name: string, arguments_: Record<string, unknown>) {
      calls.push({ name, arguments_ });
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const listed = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(
    listed.result.tools.map((tool: { name: string }) => tool.name),
    ["computer_screenshot", "computer_click", "computer_drag", "computer_move", "computer_press_key", "computer_scroll", "computer_type_text"],
  );
  await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "computer_press_key", arguments: { key: "Ctrl+l" } } });
  assert.deepEqual(calls, [{ name: "computer_press_key", arguments_: { key: "Ctrl+l" } }]);
});
