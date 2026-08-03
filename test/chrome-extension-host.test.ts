import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error Packaged runtime modules intentionally ship as plain JavaScript.
import { encodeNativeMessage, extensionHostHello, handleRuntimeRequest, MAX_CHROME_TO_HOST_MESSAGE_BYTES, MAX_HOST_TO_CHROME_MESSAGE_BYTES, NativeMessageDecoder, validateExtensionOrigin } from "../desktop/linux-runtime/chrome-extension-host.mjs";
// @ts-expect-error Packaged runtime modules intentionally ship as plain JavaScript.
import { APP_SERVER_RUNTIME_METHODS, encodeWebSocketFrame, loadChromePluginVersion, loadDesktopAgentModeDefaults, parseWebSocketUpgrade, sidePanelVersionFields, TabContextAssetStore, WebSocketFrameDecoder } from "../desktop/linux-runtime/chrome-app-server.mjs";

test("Chrome native messages use the upstream length-prefixed JSON framing", () => {
  const first = encodeNativeMessage({ jsonrpc: "2.0", id: 1, method: "getInfo" }, "LE");
  const second = encodeNativeMessage({ jsonrpc: "2.0", id: 1, result: { type: "extension" } }, "LE");
  const decoder = new NativeMessageDecoder({ endianness: "LE" });
  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    { jsonrpc: "2.0", id: 1, method: "getInfo" },
    { jsonrpc: "2.0", id: 1, result: { type: "extension" } },
  ]);
});

test("Chrome host advertises protocol v2 only to the production extension", () => {
  assert.deepEqual(extensionHostHello(), {
    manifestSchemaVersion: 2,
    nativeHostProtocolVersion: 2,
    supportedProtocolVersions: [2],
    supportedMethods: APP_SERVER_RUNTIME_METHODS,
  });
  assert.equal(validateExtensionOrigin("chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/"), true);
  assert.equal(validateExtensionOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"), false);
  assert.deepEqual(handleRuntimeRequest({ jsonrpc: "2.0", id: "native-host:1", method: "codexRuntime/hello" })?.result, extensionHostHello());
  assert.equal(handleRuntimeRequest({ jsonrpc: "2.0", id: 1, method: "getInfo" }), null);
});

test("Chrome side-panel runtime requests are dispatched without exposing the browser relay", async () => {
  const calls: unknown[] = [];
  const runtime = {
    async handleRequest(method: string, params: unknown) {
      calls.push({ method, params });
      return { localAppServerUrl: "ws://127.0.0.1:4321/?token=secret" };
    },
  };
  const response = await handleRuntimeRequest({
    jsonrpc: "2.0",
    id: "native-host:2",
    method: "codexRuntime/ensure",
    params: { clientId: "sidepanel-window-7" },
  }, runtime);
  assert.deepEqual(calls, [{ method: "codexRuntime/ensure", params: { clientId: "sidepanel-window-7" } }]);
  assert.equal(response?.result.localAppServerUrl, "ws://127.0.0.1:4321/?token=secret");
  assert.equal(handleRuntimeRequest({ jsonrpc: "2.0", id: 1, method: "getInfo" }, runtime), null);
});

function maskedTextFrame(text: string): Buffer {
  const frame = encodeWebSocketFrame(text);
  const payload = frame.subarray(2);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([Buffer.from([frame[0], 0x80 | payload.length]), mask, masked]);
}

test("loopback app-server WebSocket framing and handshake keep the token and extension origin mandatory", () => {
  const decoder = new WebSocketFrameDecoder();
  assert.deepEqual(decoder.push(maskedTextFrame('{"id":1}')), [{ opcode: 1, payload: Buffer.from('{"id":1}') }]);
  const request = [
    "GET /?token=secret&clientId=sidepanel-window-7 HTTP/1.1",
    "Origin: chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg",
    "Upgrade: websocket",
    "Connection: keep-alive, Upgrade",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "",
  ].join("\r\n");
  assert.deepEqual(parseWebSocketUpgrade(request, {
    extensionId: "hehggadaopoacecdllhhajmbjkdcmajg",
    token: "secret",
  }), { clientId: "sidepanel-window-7", key: "dGhlIHNhbXBsZSBub25jZQ==" });
  assert.throws(() => parseWebSocketUpgrade(request.replace("token=secret", "token=wrong"), {
    extensionId: "hehggadaopoacecdllhhajmbjkdcmajg",
    token: "secret",
  }), /Forbidden/);
  assert.throws(() => decoder.push(encodeWebSocketFrame("unmasked")), /masked/);
});

test("side-panel tab context assets retain exact bytes until the turn releases them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-tab-context-test-"));
  const assets = new TabContextAssetStore({ directory: path.join(root, "assets") });
  try {
    const created = await assets.create({ fileName: "selection.txt" });
    await assets.append({ assetId: created.assetId, dataBase64: Buffer.from("hello ").toString("base64") });
    await assets.append({ assetId: created.assetId, dataBase64: Buffer.from("browser").toString("base64") });
    const finished = await assets.finish({ assetId: created.assetId });
    assert.equal(await readFile(finished.path, "utf8"), "hello browser");
    await assets.remove({ assetId: created.assetId });
    await assert.rejects(readFile(finished.path), /ENOENT/);
  } finally {
    await assets.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("side-panel runtime inherits only valid desktop permission-mode defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-agent-modes-test-"));
  const statePath = path.join(root, "state.json");
  try {
    await writeFile(statePath, JSON.stringify({
      ignored: { "agent-mode-by-host-id": { local: "full-access" } },
      "electron-persisted-atom-state": {
        "agent-mode-by-host-id": { local: "auto", remote: "full-access", invalid: "root" },
        "preferred-non-full-access-agent-mode-by-host-id": {
          local: "workspace-write",
          rejected: "full-access",
        },
      },
    }));
    assert.deepEqual(await loadDesktopAgentModeDefaults({ statePath }), {
      agentModesByHostId: { local: "auto", remote: "full-access" },
      preferredNonFullAccessModesByHostId: { local: "workspace-write" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("side-panel version fields match the upstream Chrome plugin lifecycle contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-chrome-version-test-"));
  const browserClientPath = path.join(root, "scripts", "browser-client.mjs");
  try {
    await mkdir(path.dirname(browserClientPath), { recursive: true });
    await mkdir(path.join(root, ".codex-plugin"));
    await writeFile(browserClientPath, "export {};\n");
    await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "chrome",
      version: "26.727.40816",
    }));
    const version = await loadChromePluginVersion({ browserClientPath });
    assert.equal(version, "26.727.40816");
    assert.deepEqual(sidePanelVersionFields(version), {
      appVersion: "26.727.40816",
      cliVersion: "26.727.40816",
      nativeHostVersion: "26.727.40816",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome native-message limits preserve the protocol's directional capacity", () => {
  assert.equal(MAX_CHROME_TO_HOST_MESSAGE_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_HOST_TO_CHROME_MESSAGE_BYTES, 1024 * 1024);
  assert.throws(
    () => encodeNativeMessage({ value: "x".repeat(1024 * 1024) }, "LE", MAX_HOST_TO_CHROME_MESSAGE_BYTES),
    /exceeds/,
  );
});
