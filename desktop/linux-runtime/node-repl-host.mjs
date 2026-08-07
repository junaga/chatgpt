#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;
const BROWSER_PIPE_DIRECTORY = "/tmp/codex-browser-use";
const MAX_AUTHENTICATED_FETCH_RESPONSE_BYTES = 8 * 1024 * 1024;
const AUTHENTICATED_FETCH_PATHS = new Set([
  "/backend-api/me",
  "/backend-api/aura/identity",
  "/backend-api/aura/site_status",
]);

function loadTomlCodec(runtimeDirectory) {
  const roots = [
    path.resolve(runtimeDirectory, "../runtime/package.json"),
    path.resolve(runtimeDirectory, "../app/vendor-app/package.json"),
  ];
  for (const root of roots) {
    try { return createRequire(root)("smol-toml"); }
    catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("The packaged smol-toml runtime is unavailable");
}

export const NODE_REPL_TOOLS = Object.freeze([
  {
    name: "js",
    title: "Run JavaScript",
    description: "Run JavaScript in a persistent Node-backed kernel with top-level await. Use nodeRepl.write(value) for final text and await nodeRepl.emitImage(imageLike) for images. Top-level bindings persist until js_reset.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: { type: "string", minLength: 1, description: "JavaScript source to execute in the persistent Node-backed kernel." },
        timeout_ms: { type: "integer", minimum: 1, description: "Optional execution timeout in milliseconds. Defaults to 30000." },
        description: { type: "string", maxLength: 120, description: "Short user-facing description of what this code block is doing." },
      },
    },
  },
  {
    name: "js_reset",
    title: "Reset JavaScript kernel",
    description: "Reset the persistent JavaScript kernel and clear all bindings created by prior js calls.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "js_add_node_module_dir",
    title: "Add Node module directory",
    description: "Add an absolute node_modules directory to the REPL-wide Node module search roots for this server lifetime.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string", minLength: 1, description: "Absolute path to a node_modules directory." } },
    },
  },
]);

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolve_, reject_) => { resolve = resolve_; reject = reject_; });
  return { promise, resolve, reject };
}

function jsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function safeSandboxState(meta) {
  const state = meta?.["codex/sandbox-state-meta"];
  if (typeof state !== "object" || state == null || Array.isArray(state)) {
    throw new Error("node_repl requires codex/sandbox-state-meta; refusing to execute model code outside the Codex sandbox");
  }
  return state;
}

export class CodexConfigClient {
  constructor(options = {}) {
    this.codexPath = options.codexPath || "/usr/local/bin/codex";
    this.spawnProcess = options.spawnProcess || spawn;
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.child = null;
    this.startPromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
  }

  async request(method, params) {
    await this.ensureStarted();
    return await this.sendRequest(method, params);
  }

  async ensureStarted() {
    if (this.startPromise) return await this.startPromise;
    if (this.child) return;
    this.startPromise = this.start();
    try { await this.startPromise; }
    catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  async start() {
    const child = this.spawnProcess(this.codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: this.workingDirectory,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => this.handleLine(line));
    child.stderr.on("data", chunk => { this.stderr = `${this.stderr}${chunk}`.slice(-16_384); });
    child.once("error", error => this.fail(error));
    child.once("exit", (code, signal) => {
      this.fail(new Error(`Codex app-server exited (${signal || `status ${code}`})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
    });
    await this.sendRequest("initialize", {
      clientInfo: { name: "chatgpt-linux-node-repl", title: "ChatGPT", version: "0.1.0" },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    });
    jsonLine(child.stdin, { method: "initialized" });
  }

  sendRequest(method, params) {
    if (!this.child) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    const pending = deferred();
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      pending.reject(new Error(`Codex app-server request timed out: ${method}`));
    }, 10_000);
    this.pending.set(id, { ...pending, timer });
    jsonLine(this.child.stdin, { id, method, ...(params == null ? {} : { params }) });
    return pending.promise;
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    const pending = this.pending.get(message.id);
    if (pending && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Codex app-server request failed"));
      else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && typeof message.method === "string") {
      jsonLine(this.child.stdin, { id: message.id, error: { code: -32601, message: `Unsupported app-server callback: ${message.method}` } });
    }
  }

  fail(error) {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGKILL");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  stop() {
    if (!this.child) return;
    this.fail(new Error("Codex app-server stopped"));
  }
}

export function resolveCodexTomlPath(codexHome, requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.includes("\0")) {
    throw new Error("TOML path must be a non-empty string");
  }
  const root = path.resolve(codexHome);
  const candidate = path.resolve(root, requestedPath);
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(candidate).toLowerCase() !== ".toml") {
    throw new Error("TOML path must stay inside CODEX_HOME and end in .toml");
  }
  return candidate;
}

async function ensureSafeTomlParent(codexHome, file) {
  const root = path.resolve(codexHome);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const [actualRoot, actualParent] = await Promise.all([realpath(root), realpath(path.dirname(file))]);
  const relative = path.relative(actualRoot, actualParent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("TOML parent resolves outside CODEX_HOME");
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("TOML target must be a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function kernelLaunch({ codexPath, nodePath, kernelPath, runtimeRoot, workingDirectory, sandboxState }) {
  const kernelArgs = [
    "--experimental-vm-modules",
    kernelPath,
    "--session-id", randomUUID(),
    "--working-dir", workingDirectory,
  ];
  return {
    command: codexPath,
    args: [
      "sandbox",
      "--sandbox-state-json", JSON.stringify(sandboxState),
      "--sandbox-state-readable-root", runtimeRoot,
      "-C", workingDirectory,
      "--",
      nodePath,
      ...kernelArgs,
    ],
  };
}

export function allowedNativePipe(pipePath, extraAllowedPath = "") {
  if (typeof pipePath !== "string" || !path.isAbsolute(pipePath) || pipePath.includes("\0")) return false;
  const normalized = path.normalize(pipePath);
  const browserRelative = path.relative(BROWSER_PIPE_DIRECTORY, normalized);
  const browserPipe = browserRelative !== "" && !browserRelative.startsWith("..") && !path.isAbsolute(browserRelative);
  return browserPipe || (extraAllowedPath !== "" && normalized === path.normalize(extraAllowedPath));
}

export function allowedAuthenticatedFetchUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { return false; }
  return url.protocol === "https:" &&
    url.hostname === "chatgpt.com" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    AUTHENTICATED_FETCH_PATHS.has(url.pathname);
}

export function chatgptAccountIdFromToken(token) {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const auth = claims?.["https://api.openai.com/auth"];
    const accountId = auth?.chatgpt_account_id ?? claims?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

async function responseBody(response) {
  if (response.body == null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_AUTHENTICATED_FETCH_RESPONSE_BYTES) {
        throw new Error("Authenticated ChatGPT response exceeds 8 MiB");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function imageContent(imageUrl) {
  if (imageUrl.startsWith("data:")) {
    const match = imageUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("nodeRepl.emitImage returned an unsupported data URL");
    return { type: "image", mimeType: match[1], data: match[2], _meta: { "codex/imageDetail": "original" } };
  }
  const url = new URL(imageUrl);
  if (url.protocol !== "file:") throw new Error("nodeRepl.emitImage only accepts data: and file: URLs");
  const file = fileURLToPath(url);
  const extension = path.extname(file).toLowerCase();
  const mimeType = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
  return { type: "image", mimeType, data: (await readFile(file)).toString("base64"), _meta: { "codex/imageDetail": "original" } };
}

export class NodeReplRuntime {
  constructor(options = {}) {
    const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
    this.cuaRoot = options.cuaRoot || process.env.CHATGPT_LINUX_CUA_ROOT || path.resolve(runtimeDirectory, "../cua_node");
    this.nodePath = options.nodePath || path.join(this.cuaRoot, "bin", "node");
    this.kernelPath = options.kernelPath || path.join(this.cuaRoot, "lib", "node_repl", "kernel.js");
    this.codexPath = options.codexPath || process.env.CHATGPT_LINUX_SYSTEM_CODEX || process.env.CODEX_CLI_PATH || "/usr/local/bin/codex";
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.spawnProcess = options.spawnProcess || spawn;
    this.fetchImpl = options.fetchImpl || fetch;
    this.clientRequest = options.clientRequest || (async () => { throw new Error("MCP client requests are unavailable"); });
    this.codexHome = options.codexHome || process.env.CODEX_HOME || path.join(process.env.HOME || this.workingDirectory, ".codex");
    this.configClient = options.configClient || new CodexConfigClient({
      codexPath: this.codexPath,
      spawnProcess: this.spawnProcess,
      workingDirectory: this.workingDirectory,
    });
    this.tomlCodec = options.tomlCodec || null;
    this.extraPipePath = options.extraPipePath || process.env.CODEX_BROWSER_AUTH_SOCKET || "";
    this.child = null;
    this.handshakeToken = null;
    this.sandboxFingerprint = null;
    this.pendingExecs = new Map();
    this.connections = new Map();
    this.moduleDirectories = new Set();
    this.nextConnectionId = 1;
  }

  async ensureKernel(sandboxState) {
    const fingerprint = JSON.stringify(sandboxState);
    if (this.child && this.sandboxFingerprint === fingerprint) return;
    await this.reset();
    const launch = kernelLaunch({
      codexPath: this.codexPath,
      nodePath: this.nodePath,
      kernelPath: this.kernelPath,
      runtimeRoot: this.cuaRoot,
      workingDirectory: this.workingDirectory,
      sandboxState,
    });
    const child = this.spawnProcess(launch.command, launch.args, {
      cwd: this.workingDirectory,
      env: {
        ...process.env,
        NODE_REPL_NODE_MODULE_DIRS: [path.join(this.cuaRoot, "lib", "node_modules"), ...this.moduleDirectories].join(path.delimiter),
        NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: process.env.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S || "8785b5437d98636c3002d3d7e64b98db79c3b66870b1bd3d18dea953a99b1562",
        NODE_REPL_TRUSTED_CODE_PATHS: process.env.NODE_REPL_TRUSTED_CODE_PATHS || path.join(this.cuaRoot, "lib", "node_modules", "@oai", "sky"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.sandboxFingerprint = fingerprint;
    const handshake = deferred();
    this.handshake = handshake;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      try { void this.handleKernelMessage(JSON.parse(line)); }
      catch (error) { this.failKernel(new Error(`Invalid node_repl kernel output: ${errorText(error)}`)); }
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.once("error", error => this.failKernel(error));
    child.once("exit", (code, signal) => this.failKernel(new Error(`node_repl kernel exited (${signal || `status ${code}`})${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
    const timer = setTimeout(() => handshake.reject(new Error("node_repl kernel handshake timed out")), 10_000);
    try { await handshake.promise; }
    finally { clearTimeout(timer); }
  }

  async execute(args, requestMeta = {}) {
    if (typeof args.code !== "string" || args.code.trim() === "") throw new Error("js expects non-empty JavaScript source");
    const timeoutMs = args.timeout_ms == null ? DEFAULT_TIMEOUT_MS : args.timeout_ms;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeout_ms must be a positive integer");
    const sandboxState = safeSandboxState(requestMeta);
    await this.ensureKernel(sandboxState);
    const id = randomUUID();
    const pending = deferred();
    const record = { ...pending, content: [], responseMeta: null, timer: null, timeoutMs, suspended: 0, started: Date.now() };
    this.pendingExecs.set(id, record);
    this.armTimeout(id, record);
    jsonLine(this.child.stdin, {
      type: "exec",
      id,
      code: args.code,
      request_meta: requestMeta,
      form_elicitation_supported: true,
      gaas_browser_config: requestMeta?.["codex/gaas-browser-config"] || {},
    });
    return await pending.promise;
  }

  armTimeout(id, record) {
    clearTimeout(record.timer);
    if (record.suspended > 0) return;
    const elapsed = Date.now() - record.started;
    record.timer = setTimeout(() => {
      record.reject(new Error("js execution timed out; kernel reset, rerun your request"));
      this.pendingExecs.delete(id);
      void this.reset();
    }, Math.max(1, record.timeoutMs - elapsed));
  }

  async addModuleDirectory(directory) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("path must be an absolute node_modules directory");
    const normalized = path.normalize(directory);
    const added = !this.moduleDirectories.has(normalized);
    this.moduleDirectories.add(normalized);
    if (added && this.child) jsonLine(this.child.stdin, { type: "add_node_module_dir", path: normalized });
    return added;
  }

  async reset() {
    const child = this.child;
    this.child = null;
    this.handshakeToken = null;
    this.sandboxFingerprint = null;
    for (const connection of this.connections.values()) connection.destroy();
    this.connections.clear();
    if (child && !child.killed) child.kill("SIGKILL");
    for (const pending of this.pendingExecs.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("node_repl kernel reset"));
    }
    this.pendingExecs.clear();
    return true;
  }

  failKernel(error) {
    if (this.handshake) this.handshake.reject(error);
    for (const pending of this.pendingExecs.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingExecs.clear();
    this.child = null;
    this.handshakeToken = null;
  }

  requirePrivileged(message) {
    if (!this.handshakeToken || message.token !== this.handshakeToken) throw new Error("node_repl privileged bridge token mismatch");
  }

  async handleKernelMessage(message) {
    if (message.type === "privileged_bridge_handshake") {
      if (typeof message.token !== "string" || message.token === "") throw new Error("Invalid node_repl handshake");
      this.handshakeToken = message.token;
      this.handshake.resolve();
      return;
    }
    if (message.type === "exec_redacted_source" || message.type === "submitted_code_complete") return;
    const pending = this.pendingExecs.get(message.id || message.exec_id);
    if (message.type === "response_meta") {
      if (pending) pending.responseMeta = message.response_meta;
      return;
    }
    if (message.type === "emit_image") {
      try {
        if (!pending) throw new Error("Image belongs to an unknown execution");
        pending.content.push(await imageContent(message.image_url));
        jsonLine(this.child.stdin, { type: "emit_image_result", id: message.id, ok: true });
      } catch (error) {
        jsonLine(this.child.stdin, { type: "emit_image_result", id: message.id, ok: false, error: errorText(error) });
      }
      return;
    }
    if (["native_pipe_request", "elicit", "authenticated_fetch", "config_action", "launch_services_action", "suspend_timeout", "resume_timeout"].includes(message.type)) {
      this.requirePrivileged(message);
    }
    if (message.type === "native_pipe_request") return await this.handleNativePipe(message);
    if (message.type === "elicit") return await this.handleElicitation(message);
    if (message.type === "authenticated_fetch") return await this.handleAuthenticatedFetch(message);
    if (message.type === "config_action") return await this.handleConfigAction(message);
    if (message.type === "launch_services_action") {
      jsonLine(this.child.stdin, { type: "privileged_result", id: message.id, ok: false, error: "Launch Services is a macOS-only API" });
      return;
    }
    if (message.type === "suspend_timeout" || message.type === "resume_timeout") {
      if (!pending) return;
      pending.suspended = Math.max(0, pending.suspended + (message.type === "suspend_timeout" ? 1 : -1));
      if (message.type === "suspend_timeout") clearTimeout(pending.timer);
      else {
        pending.started = Date.now();
        this.armTimeout(message.exec_id, pending);
      }
      return;
    }
    if (message.type === "exec_result") {
      const record = this.pendingExecs.get(message.id);
      if (!record) return;
      clearTimeout(record.timer);
      this.pendingExecs.delete(message.id);
      if (!message.ok) {
        record.reject(new Error(message.error || "JavaScript execution failed"));
        return;
      }
      const content = [];
      if (message.output) content.push({ type: "text", text: message.output });
      for (const item of message.content_items || []) content.push({ type: "text", text: String(item) });
      content.push(...record.content);
      record.resolve({ content: content.length ? content : [{ type: "text", text: "" }], ...(record.responseMeta ? { _meta: record.responseMeta } : {}) });
    }
  }

  getTomlCodec() {
    this.tomlCodec ??= loadTomlCodec(path.dirname(fileURLToPath(import.meta.url)));
    return this.tomlCodec;
  }

  async fetchAuthStatus(refreshToken) {
    const status = await this.configClient.request("getAuthStatus", {
      includeToken: true,
      refreshToken,
    });
    if (typeof status?.authToken !== "string" || status.authToken.length === 0) {
      throw new Error("Codex ChatGPT authentication is unavailable");
    }
    return status;
  }

  async handleAuthenticatedFetch(message) {
    try {
      const request = message.request;
      if (request == null || typeof request !== "object" || !allowedAuthenticatedFetchUrl(request.url)) {
        throw new Error("nodeRepl.fetch URL is not allowlisted");
      }
      if ((request.method || "GET").toUpperCase() !== "GET") {
        throw new Error("nodeRepl.fetch only allows GET for this route");
      }
      if (Array.isArray(request.headers) && request.headers.length > 0) {
        throw new Error("nodeRepl.fetch does not allow caller headers for this route");
      }
      if (typeof request.body_base64 === "string" && request.body_base64.length > 0) {
        throw new Error("nodeRepl.fetch does not allow caller bodies for this route");
      }

      let auth = await this.fetchAuthStatus(false);
      const send = async () => {
        const headers = new Headers({
          Authorization: `Bearer ${auth.authToken}`,
          originator: "codex_browser_use",
        });
        const accountId = chatgptAccountIdFromToken(auth.authToken);
        if (accountId) headers.set("ChatGPT-Account-ID", accountId);
        return await this.fetchImpl(request.url, {
          method: "GET",
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
      };

      let response = await send();
      if (response.status === 401) {
        await response.body?.cancel();
        auth = await this.fetchAuthStatus(true);
        response = await send();
      }
      const body = await responseBody(response);
      jsonLine(this.child.stdin, {
        type: "authenticated_fetch_result",
        id: message.id,
        ok: true,
        response: {
          status: response.status,
          status_text: response.statusText,
          headers: [...response.headers].map(([name, value]) => ({ name, value })),
          ...(body.length > 0 ? { body_base64: body.toString("base64") } : {}),
        },
      });
    } catch (error) {
      jsonLine(this.child.stdin, { type: "authenticated_fetch_result", id: message.id, ok: false, error: errorText(error) });
    }
  }

  async handleConfigAction(message) {
    try {
      let value;
      if (message.action === "read_toml") {
        const file = resolveCodexTomlPath(this.codexHome, message.path);
        await ensureSafeTomlParent(this.codexHome, file);
        try { value = this.getTomlCodec().parse(await readFile(file, "utf8")); }
        catch (error) {
          if (error?.code === "ENOENT") value = {};
          else throw error;
        }
      } else if (message.action === "write_toml") {
        const file = resolveCodexTomlPath(this.codexHome, message.path);
        await ensureSafeTomlParent(this.codexHome, file);
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, this.getTomlCodec().stringify(message.value || {}), { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
        value = {};
      } else if (message.action === "read_config") {
        value = await this.configClient.request("config/read", {
          cwd: message.cwd ?? this.workingDirectory,
          includeLayers: message.include_layers === true,
        });
      } else if (message.action === "read_config_requirements") {
        value = await this.configClient.request("configRequirements/read", null);
      } else if (message.action === "write_config_value") {
        value = await this.configClient.request("config/value/write", {
          keyPath: message.key_path,
          mergeStrategy: message.merge_strategy,
          value: message.value,
          expectedVersion: message.expected_version,
        });
      } else if (message.action === "batch_write_config") {
        value = await this.configClient.request("config/batchWrite", {
          edits: (message.edits || []).map(edit => ({
            keyPath: edit.key_path,
            mergeStrategy: edit.merge_strategy,
            value: edit.value,
          })),
          expectedVersion: message.expected_version,
          reloadUserConfig: message.reload_user_config === true,
        });
      } else {
        throw new Error(`Unsupported node_repl config action: ${message.action}`);
      }
      jsonLine(this.child.stdin, { type: "privileged_result", id: message.id, ok: true, value });
    } catch (error) {
      jsonLine(this.child.stdin, { type: "privileged_result", id: message.id, ok: false, error: errorText(error) });
    }
  }

  async handleElicitation(message) {
    try {
      const response = await this.clientRequest("elicitation/create", {
        mode: "form",
        message: message.message,
        requestedSchema: message.requested_schema,
        ...(message.meta ? { _meta: message.meta } : {}),
      });
      jsonLine(this.child.stdin, {
        type: "elicitation_result",
        id: message.id,
        ok: true,
        action: response?.action || "cancel",
        content: response?.content ?? null,
        _meta: response?._meta ?? null,
      });
    } catch (error) {
      jsonLine(this.child.stdin, { type: "elicitation_result", id: message.id, ok: false, error: errorText(error) });
    }
  }

  async handleNativePipe(message) {
    if (message.op === "connect") {
      if (!allowedNativePipe(message.path, this.extraPipePath)) {
        jsonLine(this.child.stdin, { type: "native_pipe_response", id: message.id, ok: false, error: "Native pipe path is not allowlisted" });
        return;
      }
      const connectionId = `linux-pipe-${this.nextConnectionId++}`;
      const socket = net.createConnection({ path: message.path });
      socket.once("connect", () => {
        this.connections.set(connectionId, socket);
        jsonLine(this.child.stdin, { type: "native_pipe_response", id: message.id, ok: true, result: { connection_id: connectionId } });
      });
      socket.on("data", data => jsonLine(this.child.stdin, { type: "native_pipe_data", connection_id: connectionId, data_base64: data.toString("base64") }));
      socket.once("error", error => {
        if (!this.connections.has(connectionId)) jsonLine(this.child.stdin, { type: "native_pipe_response", id: message.id, ok: false, error: errorText(error) });
        else jsonLine(this.child.stdin, { type: "native_pipe_closed", connection_id: connectionId, error: errorText(error) });
      });
      socket.once("close", () => {
        this.connections.delete(connectionId);
        jsonLine(this.child.stdin, { type: "native_pipe_closed", connection_id: connectionId });
      });
      return;
    }
    const socket = this.connections.get(message.connection_id);
    if (!socket) {
      jsonLine(this.child.stdin, { type: "native_pipe_response", id: message.id, ok: false, error: "Native pipe connection was not found" });
      return;
    }
    if (message.op === "write") socket.write(Buffer.from(message.data_base64 || "", "base64"));
    else if (message.op === "close") socket.end();
    else {
      jsonLine(this.child.stdin, { type: "native_pipe_response", id: message.id, ok: false, error: "Unsupported native pipe operation" });
      return;
    }
    jsonLine(this.child.stdin, { type: "native_pipe_response", id: message.id, ok: true, result: {} });
  }
}

export class NodeReplMcpServer {
  constructor(runtime, sendClientRequest = async () => { throw new Error("MCP client requests are unavailable"); }) {
    this.runtime = runtime;
    this.sendClientRequest = sendClientRequest;
  }

  async handle(message) {
    const id = Object.hasOwn(message || {}, "id") ? message.id : undefined;
    if (!message || typeof message.method !== "string") return id === undefined ? null : { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid JSON-RPC request" } };
    if (message.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION, capabilities: { experimental: { "codex/sandbox-state-meta": {} }, tools: { listChanged: false } }, serverInfo: { name: "node_repl", version: "0.1.0-linux" }, instructions: "Use js for persistent JavaScript, js_add_node_module_dir for extra packages, and js_reset only when state cannot be reused." } };
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: NODE_REPL_TOOLS } };
    if (message.method.startsWith("notifications/")) return null;
    if (message.method !== "tools/call") return id === undefined ? null : { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    try {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      let result;
      if (name === "js") result = await this.runtime.execute(args, message.params?._meta || message._meta || {});
      else if (name === "js_reset") result = { content: [{ type: "text", text: String(await this.runtime.reset()) }] };
      else if (name === "js_add_node_module_dir") result = { content: [{ type: "text", text: String(await this.runtime.addModuleDirectory(args.path)) }] };
      else throw new Error(`Unknown tool: ${name}`);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: errorText(error) }], isError: true } };
    }
  }
}

export function serveNodeReplStdio(options = {}) {
  let nextRequestId = 1;
  const pendingClient = new Map();
  const sendClientRequest = (method, params) => {
    const id = nextRequestId++;
    const pending = deferred();
    pendingClient.set(id, pending);
    jsonLine(process.stdout, { jsonrpc: "2.0", id, method, params });
    return pending.promise;
  };
  const runtime = new NodeReplRuntime({ ...options, clientRequest: sendClientRequest });
  const server = new NodeReplMcpServer(runtime, sendClientRequest);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", async line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { jsonLine(process.stdout, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    if (!message.method && pendingClient.has(message.id)) {
      const pending = pendingClient.get(message.id);
      pendingClient.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "MCP client request failed"));
      else pending.resolve(message.result);
      return;
    }
    const response = await server.handle(message);
    if (response) jsonLine(process.stdout, response);
  });
  input.on("close", () => { void runtime.reset().finally(() => process.exit(0)); });
  return { runtime, server };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serveNodeReplStdio();
