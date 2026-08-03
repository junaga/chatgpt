import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const APP_SERVER_PROTOCOL_VERSION = 2;
export const MAX_APP_SERVER_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_TAB_CONTEXT_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_ACTIVE_TAB_CONTEXT_ASSETS = 32;

export const APP_SERVER_RUNTIME_METHODS = Object.freeze([
  "codexRuntime/ensure",
  "codexRuntime/restart",
  "codexRuntime/openLocalFile",
  "codexRuntime/tabContextAsset/create",
  "codexRuntime/tabContextAsset/appendChunk",
  "codexRuntime/tabContextAsset/finish",
  "codexRuntime/tabContextAsset/abort",
  "codexRuntime/tabContextAsset/remove",
]);

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function runtimeError(message, type = "app_server_runtime_error") {
  return Object.assign(new Error(message), { runtimeErrorType: type });
}

function safeString(value, name, options = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > (options.maximumLength || 4096)) {
    throw runtimeError(`Missing or invalid ${name}`);
  }
  return value;
}

function optionalAbsolutePath(value, name) {
  if (value == null) return null;
  const checked = safeString(value, name);
  if (!path.isAbsolute(checked)) throw runtimeError(`${name} must be an absolute path`);
  return checked;
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1";
}

function packagedRuntimeConfig() {
  const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
  const resources = path.resolve(runtimeDirectory, "..");
  return {
    schemaVersion: 1,
    channel: "prod",
    browserClientPath: path.join(resources, "plugins", "openai-bundled", "plugins", "chrome", "scripts", "browser-client.mjs"),
    codexCliPath: path.join(resources, "codex"),
    nodePath: path.join(resources, "cua_node", "bin", "node"),
    nodeReplPath: path.join(resources, "cua_node", "bin", "node_repl"),
    proxyHost: "127.0.0.1",
    proxyPort: 0,
  };
}

export async function loadExtensionHostConfig(options = {}) {
  const fallback = packagedRuntimeConfig();
  const hostPath = options.extensionHostPath || process.env.CHATGPT_LINUX_EXTENSION_HOST_PATH;
  const configPath = options.configPath || (hostPath ? path.join(path.dirname(hostPath), "extension-host-config.json") : null);
  let parsed = null;
  if (configPath) {
    try { parsed = JSON.parse(await readFile(configPath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") throw runtimeError(`Failed to read Chrome extension host configuration: ${errorText(error)}`);
    }
  }
  const config = { ...fallback, ...(parsed || {}) };
  if (config.schemaVersion !== 1) throw runtimeError("Chrome extension host configuration must use schemaVersion 1");
  config.browserClientPath = optionalAbsolutePath(config.browserClientPath, "browserClientPath");
  config.codexCliPath = optionalAbsolutePath(config.codexCliPath, "codexCliPath");
  config.nodePath = optionalAbsolutePath(config.nodePath, "nodePath");
  config.nodeReplPath = optionalAbsolutePath(config.nodeReplPath, "nodeReplPath");
  config.proxyHost = safeString(config.proxyHost, "proxyHost", { maximumLength: 64 });
  if (!isLoopbackHost(config.proxyHost)) throw runtimeError("The Chrome app-server proxy must bind to a loopback address");
  if (!Number.isInteger(config.proxyPort) || config.proxyPort < 0 || config.proxyPort > 65535) {
    throw runtimeError("proxyPort must be an integer between 0 and 65535");
  }
  return config;
}

async function sha256File(file) {
  if (file == null) return [];
  try { return [createHash("sha256").update(await readFile(file)).digest("hex")]; }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

export async function loadChromePluginVersion(config) {
  const browserClientPath = optionalAbsolutePath(config.browserClientPath, "browserClientPath");
  if (browserClientPath == null) throw runtimeError("Missing browserClientPath", "required_path_missing");
  const manifestPath = path.join(path.resolve(path.dirname(browserClientPath), ".."), ".codex-plugin", "plugin.json");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) {
    throw runtimeError(`Failed to read Chrome plugin version: ${errorText(error)}`, "required_path_missing");
  }
  if (manifest?.name !== "chrome" || typeof manifest.version !== "string" || !PLUGIN_VERSION_PATTERN.test(manifest.version)) {
    throw runtimeError("Chrome plugin manifest has an invalid name or version", "manifest_invalid");
  }
  return manifest.version;
}

export function sidePanelVersionFields(pluginVersion) {
  if (typeof pluginVersion !== "string" || !PLUGIN_VERSION_PATTERN.test(pluginVersion)) {
    throw runtimeError("Chrome plugin version is invalid", "manifest_invalid");
  }
  // The macOS lifecycle publishes the Chrome plugin version for all three
  // version fields in chrome-native-hosts-v2.json; the native host forwards
  // those values in the ensure/restart result.
  return {
    appVersion: pluginVersion,
    cliVersion: pluginVersion,
    nativeHostVersion: pluginVersion,
  };
}

const AGENT_MODES = new Set(["auto", "read-only", "workspace-write", "full-access", "custom"]);
const NON_FULL_ACCESS_AGENT_MODES = new Set(["auto", "read-only", "workspace-write"]);

function filterAgentModes(value, allowedModes) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(([hostId, mode]) =>
    typeof hostId === "string" && hostId.length > 0 && hostId.length <= 4096 && allowedModes.has(mode),
  );
  return Object.fromEntries(entries);
}

export async function loadDesktopAgentModeDefaults(options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const statePath = options.statePath || path.join(codexHome, ".codex-global-state.json");
  let state;
  try { state = JSON.parse(await readFile(statePath, "utf8")); }
  catch { return null; }
  const persistedState = state?.["electron-persisted-atom-state"];
  if (persistedState == null || typeof persistedState !== "object" || Array.isArray(persistedState)) return null;
  return {
    agentModesByHostId: filterAgentModes(persistedState["agent-mode-by-host-id"], AGENT_MODES),
    preferredNonFullAccessModesByHostId: filterAgentModes(
      persistedState["preferred-non-full-access-agent-mode-by-host-id"],
      NON_FULL_ACCESS_AGENT_MODES,
    ),
  };
}

export async function buildSidePanelRuntimeConfig(config, options = {}) {
  const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const moduleDirectories = [
    path.join(resources, "cua_node", "lib", "node_modules"),
    path.join(resources, "plugins", "openai-bundled", "plugins", "chrome", "scripts", "node_modules"),
  ];
  return {
    browserClientPath: config.browserClientPath,
    codexCliPath: config.codexCliPath,
    desktopAgentModeDefaults: await loadDesktopAgentModeDefaults(options),
    nodeModuleDirs: moduleDirectories,
    nodePath: config.nodePath,
    nodeReplPath: config.nodeReplPath,
    platform: "linux",
    trustedBrowserClientSha256s: await sha256File(config.browserClientPath),
  };
}

export function encodeWebSocketFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

export class WebSocketFrameDecoder {
  constructor(options = {}) {
    this.maximumBytes = options.maximumBytes || MAX_APP_SERVER_MESSAGE_BYTES;
    this.requireMask = options.requireMask !== false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if ((first & 0x70) !== 0) throw new Error("WebSocket extensions are not supported");
      if (this.requireMask && !masked) throw new Error("Client WebSocket frames must be masked");
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        const wideLength = this.buffer.readBigUInt64BE(2);
        if (wideLength > BigInt(this.maximumBytes)) throw new Error("WebSocket message exceeded maximum allowed size");
        length = Number(wideLength);
        offset = 10;
      }
      if (length > this.maximumBytes) throw new Error("WebSocket message exceeded maximum allowed size");
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + length) break;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode >= 0x8) {
        if (!final || payload.length > 125) throw new Error("Invalid WebSocket control frame");
        messages.push({ opcode, payload });
        continue;
      }
      if (opcode === 0x0) {
        if (this.fragmentOpcode == null) throw new Error("Unexpected WebSocket continuation frame");
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentOpcode != null) throw new Error("Interleaved WebSocket messages are not supported");
        this.fragmentOpcode = opcode;
      } else {
        throw new Error(`Unsupported WebSocket opcode ${opcode}`);
      }
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maximumBytes) throw new Error("WebSocket message exceeded maximum allowed size");
      if (final) {
        messages.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments, this.fragmentBytes) });
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOpcode = null;
      }
    }
    return messages;
  }
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function parseWebSocketUpgrade(requestText, options) {
  const lines = requestText.split("\r\n");
  const requestLine = lines.shift()?.split(" ");
  if (requestLine?.length !== 3 || requestLine[0] !== "GET" || requestLine[2] !== "HTTP/1.1") {
    throw new Error("Invalid WebSocket request line");
  }
  const headers = new Map();
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("Invalid WebSocket header");
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const url = new URL(requestLine[1], "http://127.0.0.1");
  if (url.pathname !== "/" || !tokenMatches(url.searchParams.get("token"), options.token)) throw new Error("Forbidden");
  const origin = headers.get("origin");
  const allowedOrigins = new Set([`chrome-extension://${options.extensionId}`, `chrome-extension://${options.extensionId}/`]);
  if (!allowedOrigins.has(origin)) throw new Error("Forbidden");
  if (headers.get("upgrade")?.toLowerCase() !== "websocket") throw new Error("Missing WebSocket upgrade header");
  if (!headers.get("connection")?.toLowerCase().split(",").map(value => value.trim()).includes("upgrade")) {
    throw new Error("Missing WebSocket connection upgrade");
  }
  if (headers.get("sec-websocket-version") !== "13") throw new Error("Unsupported WebSocket version");
  const key = headers.get("sec-websocket-key");
  if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) throw new Error("Missing WebSocket key");
  const clientId = url.searchParams.get("clientId") || "default";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) throw new Error("Invalid app-server clientId");
  return { clientId, key };
}

class AppServerProcess {
  constructor(options) {
    this.clientId = options.clientId;
    this.child = options.spawnProcess(options.codexPath, ["app-server", "--listen", "stdio://", "--analytics-default-enabled"], {
      cwd: options.workingDirectory,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.socket = null;
    this.stderr = "";
    this.exited = false;
    this.started = new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      const socket = this.socket;
      if (socket && !socket.destroyed) socket.write(encodeWebSocketFrame(line));
    });
    this.child.stderr.on("data", chunk => { this.stderr = `${this.stderr}${chunk}`.slice(-16_384); });
    this.child.once("error", error => this.fail(error));
    this.child.once("exit", (code, signal) => this.fail(new Error(`Codex app-server exited (${signal || `status ${code}`})`)));
  }

  fail(error) {
    if (this.exited) return;
    this.exited = true;
    if (this.socket && !this.socket.destroyed) this.socket.destroy(error);
    this.socket = null;
  }

  attach(socket, initialBytes = Buffer.alloc(0)) {
    if (this.exited) throw runtimeError(`Codex app-server for ${this.clientId} is not running${this.stderr ? `: ${this.stderr}` : ""}`);
    if (this.socket && this.socket !== socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = socket;
    const decoder = new WebSocketFrameDecoder();
    const consume = chunk => {
      for (const message of decoder.push(chunk)) {
        if (message.opcode === 0x8) {
          socket.end(encodeWebSocketFrame(message.payload, 0x8));
        } else if (message.opcode === 0x9) {
          socket.write(encodeWebSocketFrame(message.payload, 0xa));
        } else if (message.opcode === 0x1) {
          const text = message.payload.toString("utf8");
          if (!Buffer.from(text, "utf8").equals(message.payload)) throw new Error("App-server WebSocket message is not valid UTF-8");
          const json = JSON.parse(text);
          if (json == null || typeof json !== "object" || Array.isArray(json)) throw new Error("App-server WebSocket message must be a JSON object");
          this.child.stdin.write(`${JSON.stringify(json)}\n`);
        } else if (message.opcode === 0x2) {
          throw new Error("Binary app-server WebSocket messages are not supported");
        }
      }
    };
    socket.on("data", chunk => {
      try { consume(chunk); }
      catch { socket.destroy(); }
    });
    socket.once("close", () => { if (this.socket === socket) this.socket = null; });
    socket.once("error", () => { if (this.socket === socket) this.socket = null; });
    if (initialBytes.length > 0) consume(initialBytes);
  }

  close() {
    this.exited = true;
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    if (!this.child.killed) this.child.kill("SIGKILL");
  }
}

export class AppServerProxy {
  constructor(options) {
    this.config = options.config;
    this.extensionId = options.extensionId;
    this.spawnProcess = options.spawnProcess || spawn;
    this.workingDirectory = options.workingDirectory || os.homedir();
    this.token = options.token || randomBytes(32).toString("base64url");
    this.processes = new Map();
    this.server = null;
    this.url = null;
  }

  async start() {
    if (this.server) return;
    this.server = net.createServer(socket => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: this.config.proxyHost, port: this.config.proxyPort }, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (typeof address !== "object" || address == null) throw runtimeError("Failed to read Chrome app-server proxy address");
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    this.url = `ws://${host}:${address.port}/?token=${encodeURIComponent(this.token)}`;
  }

  async ensure(clientId = "default", restart = false) {
    await this.start();
    const checkedId = safeString(clientId, "clientId", { maximumLength: 128 });
    if (!/^[A-Za-z0-9._-]+$/.test(checkedId)) throw runtimeError("Invalid app-server clientId");
    if (restart) this.processes.get(checkedId)?.close();
    if (restart) this.processes.delete(checkedId);
    let appServer = this.processes.get(checkedId);
    if (!appServer) {
      appServer = new AppServerProcess({
        clientId: checkedId,
        codexPath: safeString(this.config.codexCliPath, "codexCliPath"),
        environment: {
          ...process.env,
          CODEX_CLI_PATH: this.config.codexCliPath,
          CODEX_BROWSER_USE_NODE_PATH: this.config.nodePath,
          CODEX_BROWSER_CLIENT_PATH: this.config.browserClientPath,
          CODEX_NODE_REPL_PATH: this.config.nodeReplPath,
        },
        spawnProcess: this.spawnProcess,
        workingDirectory: this.workingDirectory,
      });
      this.processes.set(checkedId, appServer);
    }
    try { await appServer.started; }
    catch (error) {
      this.processes.delete(checkedId);
      appServer.close();
      throw runtimeError(`Failed to start Codex app-server: ${errorText(error)}`);
    }
    return this.url;
  }

  accept(socket) {
    let header = Buffer.alloc(0);
    const readHeader = chunk => {
      header = Buffer.concat([header, chunk]);
      if (header.length > 64 * 1024) return socket.destroy();
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", readHeader);
      try {
        const request = parseWebSocketUpgrade(header.subarray(0, end).toString("utf8"), {
          extensionId: this.extensionId,
          token: this.token,
        });
        const appServer = this.processes.get(request.clientId);
        if (!appServer) {
          socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found");
          return;
        }
        const accept = createHash("sha1").update(`${request.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        appServer.attach(socket, header.subarray(end + 4));
      } catch (error) {
        const forbidden = errorText(error) === "Forbidden";
        const body = forbidden ? "Forbidden" : "Bad Request";
        socket.end(`HTTP/1.1 ${forbidden ? "403 Forbidden" : "400 Bad Request"}\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      }
    };
    socket.on("data", readHeader);
  }

  async close() {
    for (const appServer of this.processes.values()) appServer.close();
    this.processes.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise(resolve => server.close(resolve));
  }
}

function validAssetFilename(value) {
  const filename = safeString(value, "fileName", { maximumLength: 240 });
  if (filename === "." || filename === ".." || filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
    throw runtimeError("Invalid Chrome tab context asset filename");
  }
  return filename;
}

function decodeAssetChunk(value) {
  const data = safeString(value, "dataBase64", { maximumLength: 12 * 1024 * 1024 });
  if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw runtimeError("Invalid Chrome tab context asset chunk");
  }
  return Buffer.from(data, "base64");
}

export class TabContextAssetStore {
  constructor(options = {}) {
    this.directory = options.directory || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "codex-tab-context-assets");
    this.assets = new Map();
  }

  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(this.directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw runtimeError("Chrome tab context asset directory is unsafe");
    if (typeof process.getuid === "function" && entry.uid !== process.getuid()) throw runtimeError("Chrome tab context asset directory has a different owner");
    await chmod(this.directory, 0o700);
  }

  async create(params) {
    await this.prepare();
    if (this.assets.size >= MAX_ACTIVE_TAB_CONTEXT_ASSETS) throw runtimeError("Too many active Chrome tab context assets");
    const assetId = randomUUID();
    const file = path.join(this.directory, `${assetId}-${validAssetFilename(params?.fileName)}`);
    const handle = await open(file, "wx", 0o600);
    this.assets.set(assetId, { bytes: 0, file, finished: false, handle });
    return { assetId };
  }

  get(assetId) {
    const checked = safeString(assetId, "assetId", { maximumLength: 128 });
    const asset = this.assets.get(checked);
    if (!asset) throw runtimeError("Chrome tab context asset was not found");
    return [checked, asset];
  }

  async append(params) {
    const [, asset] = this.get(params?.assetId);
    if (asset.finished) throw runtimeError("Chrome tab context asset is already finished");
    const chunk = decodeAssetChunk(params?.dataBase64);
    if (asset.bytes + chunk.length > MAX_TAB_CONTEXT_ASSET_BYTES) throw runtimeError("Chrome tab context asset is too large");
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await asset.handle.write(chunk, offset, chunk.length - offset, null);
      if (bytesWritten === 0) throw runtimeError("Failed to write Chrome tab context asset");
      offset += bytesWritten;
    }
    asset.bytes += chunk.length;
    return {};
  }

  async finish(params) {
    const [assetId, asset] = this.get(params?.assetId);
    if (!asset.finished) {
      await asset.handle.sync();
      await asset.handle.close();
      asset.handle = null;
      asset.finished = true;
    }
    return { assetId, path: asset.file };
  }

  async remove(params) {
    const [assetId, asset] = this.get(params?.assetId);
    if (asset.handle) await asset.handle.close().catch(() => {});
    await rm(asset.file, { force: true });
    this.assets.delete(assetId);
    return {};
  }

  async close() {
    await Promise.all([...this.assets.keys()].map(assetId => this.remove({ assetId }).catch(() => {})));
  }
}

export async function openLocalFile(file, options = {}) {
  const checked = safeString(file, "path");
  if (!path.isAbsolute(checked)) throw runtimeError("Local file path must be absolute");
  let entry;
  try { entry = await lstat(checked); }
  catch (error) {
    if (error?.code === "ENOENT") throw runtimeError("Local file does not exist");
    throw error;
  }
  if (entry.isSymbolicLink()) throw runtimeError("Opening symbolic links is not supported");
  if (!entry.isFile() && !entry.isDirectory()) throw runtimeError("Invalid local file path");
  const blockedExtension = /\.(?:command|desktop|jar|terminal|tool)$/i.test(checked);
  if (blockedExtension || (entry.isFile() && (entry.mode & 0o111) !== 0)) throw runtimeError("Opening executable files is not supported");
  const spawnProcess = options.spawnProcess || spawn;
  const child = spawnProcess("xdg-open", [checked], { detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref?.();
  return {};
}

export class ChromeExtensionRuntime {
  constructor(options = {}) {
    this.options = options;
    this.config = null;
    this.proxy = null;
    this.pluginVersion = null;
    this.runtimeConfig = null;
    this.assets = options.assets || new TabContextAssetStore(options.assetOptions);
  }

  async prepare() {
    if (this.config) return;
    this.config = await loadExtensionHostConfig(this.options);
    this.pluginVersion = await loadChromePluginVersion(this.config);
    this.runtimeConfig = await buildSidePanelRuntimeConfig(this.config, this.options);
    this.proxy = new AppServerProxy({
      config: this.config,
      extensionId: this.options.extensionId,
      spawnProcess: this.options.spawnProcess,
      workingDirectory: this.options.workingDirectory,
      token: this.options.token,
    });
  }

  async handleRequest(method, params) {
    if (method === "codexRuntime/openLocalFile") return await openLocalFile(params?.path, this.options);
    if (method === "codexRuntime/tabContextAsset/create") return await this.assets.create(params);
    if (method === "codexRuntime/tabContextAsset/appendChunk") return await this.assets.append(params);
    if (method === "codexRuntime/tabContextAsset/finish") return await this.assets.finish(params);
    if (method === "codexRuntime/tabContextAsset/abort" || method === "codexRuntime/tabContextAsset/remove") {
      return await this.assets.remove(params);
    }
    if (method !== "codexRuntime/ensure" && method !== "codexRuntime/restart") {
      throw runtimeError(`Unsupported Chrome runtime method: ${method}`);
    }
    await this.prepare();
    const constraints = params?.constraints;
    if (constraints == null || typeof constraints !== "object" || Array.isArray(constraints)) {
      throw runtimeError("Missing Chrome runtime constraints");
    }
    if (constraints.extensionId !== this.options.extensionId ||
        constraints.requiredNativeHostProtocolVersion !== 2) {
      throw runtimeError("No compatible Chrome native host entry was found", "version_mismatch");
    }
    if (constraints?.requiredAppServerProtocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
      throw runtimeError("No Codex app-server entry matches the required protocol version", "version_mismatch");
    }
    const clientId = params?.clientId || "default";
    const localAppServerUrl = await this.proxy.ensure(clientId, method === "codexRuntime/restart");
    return {
      entryId: "chatgpt-linux",
      localAppServerUrl,
      appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
      ...sidePanelVersionFields(this.pluginVersion),
      channel: this.config.channel || "prod",
      nativeHostProtocolVersion: 2,
      runtimeConfig: this.runtimeConfig,
    };
  }

  async close() {
    await Promise.all([this.proxy?.close(), this.assets.close()]);
  }
}
