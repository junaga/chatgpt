import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PIP_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const RUNTIME_KEY = Symbol.for("openai.computer-use.runtime");
const CHROME_COMPUTER_USE_META_KEY = "codex/computerUseChrome";
const CHROME_APP_PATTERN = /(?:^|[\\/])(?:google-chrome|chromium|chrome)(?:[\\/]|$)/i;
const SKY_LINUX_CLIENT_ENTRYPOINT = [
  "@oai", "sky", "dist", "project", "cua", "sky_js", "src", "targets", "linux",
  "create_client.js",
];

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function bridgePath() {
  const configured = (
    nodeRepl()?.env?.CHATGPT_LINUX_COMPUTER_USE_BRIDGE
    || process.env.CHATGPT_LINUX_COMPUTER_USE_BRIDGE
  )?.trim();
  if (configured) return configured;
  const nodeModuleDirs = (
    nodeRepl()?.env?.NODE_REPL_NODE_MODULE_DIRS
    || process.env.NODE_REPL_NODE_MODULE_DIRS
  )?.trim();
  if (nodeModuleDirs) {
    const nodeModuleRoot = nodeModuleDirs.split(path.delimiter).find(Boolean);
    if (nodeModuleRoot) {
      return path.resolve(nodeModuleRoot, "../../bin/chatgpt-linux-computer-use");
    }
  }
  const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return path.resolve(pluginRoot, "../../../../linux-runtime/bin/chatgpt-linux-computer-use");
}

function runtimeEnvironment(overrides) {
  return {
    ...process.env,
    ...(nodeRepl()?.env || {}),
    ...(overrides || {}),
  };
}

async function importPackagedLinuxClient(environment) {
  const moduleDirs = environment.NODE_REPL_NODE_MODULE_DIRS;
  const searchRoots = typeof moduleDirs === "string" ? moduleDirs.split(path.delimiter) : [];
  let lastError;
  for (const searchRoot of searchRoots) {
    if (!searchRoot.trim()) continue;
    const resolvedRoot = path.resolve(searchRoot);
    const nodeModulesRoot = path.basename(resolvedRoot) === "node_modules"
      ? resolvedRoot
      : path.join(resolvedRoot, "node_modules");
    try {
      const module = await import(pathToFileURL(
        path.join(nodeModulesRoot, ...SKY_LINUX_CLIENT_ENTRYPOINT),
      ).href);
      if (typeof module.create_client !== "function") {
        throw new Error("@oai/sky is missing the compiled Linux create_client entrypoint");
      }
      return module.create_client({ target: "linux" });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Computer Use could not load the bundled @oai/sky Linux client", {
    cause: lastError,
  });
}

function x11RawInputAllowed(environment) {
  const wayland = environment.XDG_SESSION_TYPE?.toLowerCase() === "wayland"
    || (!environment.XDG_SESSION_TYPE && environment.WAYLAND_DISPLAY && !environment.DISPLAY);
  return Boolean(environment.DISPLAY)
    && (!wayland || environment.CHATGPT_COMPUTER_USE_ALLOW_XWAYLAND === "1");
}

export class LinuxComputerUseTransport {
  constructor(options = {}) {
    this.executable = options.executable || bridgePath();
    this.spawnProcess = options.spawnProcess || spawn;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextRequestId = 1;
  }

  ensureProcess() {
    if (this.child) return this.child;
    const child = this.spawnProcess(this.executable, ["serve"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.stdout.on("data", chunk => this.consume(Buffer.from(chunk)));
    child.once("error", error => this.fail(error));
    child.once("exit", (code, signal) => {
      this.fail(new Error(
        stderr.trim()
          || `Linux Computer Use bridge exited (${signal || `status ${code ?? "unknown"}`})`,
      ));
    });
    return child;
  }

  request(method, params) {
    const child = this.ensureProcess();
    const requestId = this.nextRequestId++;
    const payload = Buffer.from(JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
      method,
      ...(params === undefined ? {} : { params }),
    }));
    if (payload.length > MAX_FRAME_BYTES) {
      return Promise.reject(new Error("Linux Computer Use request is too large"));
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      child.stdin.write(Buffer.concat([header, payload]), error => {
        if (!error) return;
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.fail(new Error(`Linux Computer Use response is too large: ${length} bytes`));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let response;
      try { response = JSON.parse(payload.toString("utf8")); }
      catch (error) {
        this.fail(new Error(`Linux Computer Use returned invalid JSON: ${errorText(error)}`));
        return;
      }
      if (response?.protocol_version !== PROTOCOL_VERSION) {
        this.fail(new Error(
          `Linux Computer Use protocol mismatch: received ${response?.protocol_version ?? "missing"}`,
        ));
        return;
      }
      const pending = this.pending.get(response.request_id);
      if (!pending) continue;
      this.pending.delete(response.request_id);
      if (response.status === "ok") pending.resolve(response.result);
      else {
        const error = new Error(response.error?.message || "Linux Computer Use request failed");
        error.code = response.error?.code;
        error.retryable = response.error?.retryable === true;
        error.targetBounds = response.error?.target_bounds;
        pending.reject(error);
      }
    }
  }

  fail(error) {
    const child = this.child;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    if (child && child.exitCode == null && child.signalCode == null) child.kill();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode == null && child.signalCode == null) child.kill();
  }
}

function plainInput(input, method) {
  if (typeof input !== "object" || input == null || Array.isArray(input)) {
    throw new TypeError(`${method} input must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const copy = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) {
      throw new TypeError(`${method}.${key} must be a plain data property`);
    }
    Object.defineProperty(copy, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

function requiredApp(input, method) {
  const app = input.app;
  if (typeof app !== "string" || app.trim() === "") throw new TypeError(`${method}.app is required`);
  return app.trim();
}

function resultValue(result, expected) {
  if (result?.type !== expected) {
    throw new Error(`Linux Computer Use returned ${result?.type || "an invalid result"}; expected ${expected}`);
  }
  return result.value;
}

function nodeRepl() {
  return globalThis.nodeRepl;
}

async function suspended(operation) {
  const suspend = nodeRepl()?.withSuspendedTimeout;
  return typeof suspend === "function" ? await suspend(operation) : await operation();
}

function setToolSurface(app = null, screenshotUrl = null) {
  const meta = {
    "codex/toolSurface": {
      kind: "computerUse",
      app: app == null ? null : { kind: "appId", appId: app },
      ...(screenshotUrl == null ? {} : { screenshot: { url: screenshotUrl } }),
    },
  };
  if (app != null && isChromeApp(app)) meta[CHROME_COMPUTER_USE_META_KEY] = true;
  nodeRepl()?.setResponseMeta?.(meta);
}

async function imageDataUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.startsWith("data:image/")) {
    return value.length <= Math.ceil(MAX_PIP_SCREENSHOT_BYTES / 3) * 4 + 128 ? value : null;
  }
  let url;
  try { url = new URL(value); }
  catch { return null; }
  if (url.protocol !== "file:") return null;
  try {
    const details = await stat(url);
    if (!details.isFile() || details.size > MAX_PIP_SCREENSHOT_BYTES) return null;
    const data = await readFile(url);
    const extension = path.extname(fileURLToPath(url)).toLowerCase();
    const mime = extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".webp" ? "image/webp" : "image/png";
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

function isChromeApp(app) {
  const normalized = app.trim().toLowerCase();
  return [
    "chrome", "google chrome", "chromium", "com.google.chrome", "org.chromium.chromium",
  ].includes(normalized) || CHROME_APP_PATTERN.test(app);
}

export function createClient(options = {}) {
  const transport = options.transport || new LinuxComputerUseTransport(options);
  const environment = runtimeEnvironment(options.environment);
  let rawClientPromise;
  const approvedApps = new Set();
  const screenshotByApp = new Map();
  const pendingApprovals = new Map();

  async function rawClient() {
    if (!x11RawInputAllowed(environment)) {
      throw new Error(
        "The compositor did not provide native Wayland control; XWayland fallback is disabled",
      );
    }
    rawClientPromise ||= Promise.resolve(
      options.rawClient || importPackagedLinuxClient(environment),
    );
    return await rawClientPromise;
  }

  async function approve(app) {
    const key = app.toLowerCase();
    if (approvedApps.has(key)) return;
    if (pendingApprovals.has(key)) return await pendingApprovals.get(key);
    const createElicitation = nodeRepl()?.createElicitation;
    if (typeof createElicitation !== "function") {
      throw new Error("Computer Use requires nodeRepl.createElicitation for per-app approval");
    }
    const approval = suspended(async () => {
      const response = await createElicitation({
        message: `Allow Computer Use to use "${app}"?`,
        meta: {
          codex_approval_kind: "mcp_tool_call",
          codex_request_type: "approval_request",
          connector_id: "computer-use",
          connector_name: "Computer Use",
          persist: ["session"],
          riskLevel: "low",
          tool_name: "computer_use",
          tool_params: { app },
          tool_params_display: [{ name: "app", display_name: "App", value: app }],
        },
      });
      if (response?.action !== "accept") throw new Error(`Computer Use was not approved to use ${app}`);
      approvedApps.add(key);
    });
    pendingApprovals.set(key, approval);
    try { await approval; }
    finally { pendingApprovals.delete(key); }
  }

  async function appRequest(method, input, makeParams = value => value) {
    const normalized = plainInput(input, method);
    const app = requiredApp(normalized, method);
    setToolSurface(null);
    await approve(app);
    setToolSurface(app, screenshotByApp.get(app.toLowerCase()) ?? null);
    return await suspended(() => transport.request(method, makeParams(normalized)));
  }

  async function action(kind, input) {
    try {
      await appRequest("action", input, value => ({ ...value, kind }));
    } catch (error) {
      const normalized = plainInput(input, kind);
      await rawFallback(kind, normalized, error);
    }
  }

  async function rawFallback(kind, input, error) {
    const bounds = error?.targetBounds;
    const semanticClickFallback = kind === "click" && bounds != null;
    if (error?.code !== "noActiveSession" && !semanticClickFallback) throw error;
    const raw = await rawClient();
    if (kind === "click") {
      const point = input.x != null && input.y != null
        ? { x: input.x, y: input.y }
        : boundsCenter(bounds);
      await raw.click({
        ...point,
        ...(input.mouse_button == null ? {} : { mouse_button: input.mouse_button }),
        ...(input.click_count == null ? {} : { click_count: input.click_count }),
      });
      return;
    }
    if (kind === "drag") {
      await raw.drag({
        from_x: input.from_x,
        from_y: input.from_y,
        to_x: input.to_x,
        to_y: input.to_y,
      });
      return;
    }
    if (kind === "press_key") {
      await raw.press_key({ key: input.key });
      return;
    }
    if (kind === "type_text") {
      await raw.type_text({ text: input.text });
      return;
    }
    if (kind === "scroll") {
      const point = boundsCenter(bounds);
      await raw.scroll({
        direction: input.direction,
        pixels: (input.pages ?? 1) * 800,
        ...point,
      });
      return;
    }
    throw error;
  }

  const client = {
    target: "linux",
    async list_apps() {
      setToolSurface(null);
      return resultValue(await suspended(() => transport.request("list_apps")), "apps");
    },
    async get_app_state(input) {
      const normalized = plainInput(input, "get_app_state");
      const app = requiredApp(normalized, "get_app_state");
      const result = await appRequest("get_app_state", input, value => ({
        app: requiredApp(value, "get_app_state"),
        disableDiff: value.disableDiff === true,
      }));
      let state = resultValue(result, "app_state");
      if (state.screenshot == null && x11RawInputAllowed(environment)) {
        let screenshots;
        try {
          screenshots = await (await rawClient()).get_screenshot();
        } catch (error) {
          state = {
            ...state,
            text: `${state.text}\nScreenshot unavailable: ${errorText(error)}`,
          };
        }
        const first = screenshots?.[0];
        const url = typeof first?.filepath === "string" && first.filepath
          ? pathToFileURL(first.filepath).href
          : first?.data_url;
        if (typeof url === "string" && url) {
          state = {
            ...state,
            screenshot: { url },
            text: screenshots.length > 1
              ? `${state.text}\nFull-desktop capture includes ${screenshots.length} displays; screenshot contains display 1.`
              : state.text,
          };
        }
      }
      const screenshot = await imageDataUrl(state.screenshot?.url);
      if (screenshot != null) screenshotByApp.set(app.toLowerCase(), screenshot);
      setToolSurface(app, screenshot);
      return state;
    },
    click: input => action("click", input),
    drag: input => action("drag", input),
    press_key: input => action("press_key", input),
    type_text: input => action("type_text", input),
    scroll: input => action("scroll", input),
    set_value: input => action("set_value", input),
    perform_secondary_action: input => action("perform_secondary_action", input),
    select_text: input => action("select_text", input),
    close() { transport.close?.(); },
  };
  return Object.freeze(client);
}

function boundsCenter(bounds) {
  if (typeof bounds !== "object" || bounds == null) {
    throw new Error("Raw input fallback requires current accessibility bounds");
  }
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite)) {
    throw new Error("Raw input fallback received invalid accessibility bounds");
  }
  return { x: x + width / 2, y: y + height / 2 };
}

export async function setupComputerUseRuntime({ globals = globalThis, transport } = {}) {
  let client = globalThis[RUNTIME_KEY];
  if (!client) {
    client = createClient({ transport });
    Object.defineProperty(globalThis, RUNTIME_KEY, { value: client });
  }
  Reflect.set(globalThis, "sky", client);
  Reflect.set(globals, "sky", client);
  return client;
}
