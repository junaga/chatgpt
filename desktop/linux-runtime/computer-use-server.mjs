import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { McpServer, serveStdio } from "./mcp-server.mjs";

const DIRECTIONS = new Set(["up", "down", "left", "right", "u", "d", "l", "r"]);
const MOUSE_BUTTONS = new Set(["left", "right", "middle", "l", "r", "m"]);

function requiredString(arguments_, key, { allowEmpty = false } = {}) {
  const value = arguments_[key];
  if (typeof value !== "string" || (!allowEmpty && !value.length)) {
    throw new Error(`${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function optionalString(arguments_, key) {
  const value = arguments_[key];
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.length) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function requiredNumber(arguments_, key) {
  const value = arguments_[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function optionalNumber(arguments_, key) {
  const value = arguments_[key];
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function validateComputerArguments(name, arguments_) {
  if (name === "computer_screenshot") return {};
  if (name === "computer_click") {
    const mouseButton = optionalString(arguments_, "mouse_button");
    if (mouseButton && !MOUSE_BUTTONS.has(mouseButton)) throw new Error("mouse_button is not supported");
    const clickCount = optionalNumber(arguments_, "click_count");
    if (clickCount != null && (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3)) {
      throw new Error("click_count must be an integer from 1 to 3");
    }
    return compact({
      x: requiredNumber(arguments_, "x"),
      y: requiredNumber(arguments_, "y"),
      mouse_button: mouseButton,
      click_count: clickCount,
      key: optionalString(arguments_, "key"),
    });
  }
  if (name === "computer_drag") {
    return compact({
      from_x: requiredNumber(arguments_, "from_x"),
      from_y: requiredNumber(arguments_, "from_y"),
      to_x: requiredNumber(arguments_, "to_x"),
      to_y: requiredNumber(arguments_, "to_y"),
      key: optionalString(arguments_, "key"),
    });
  }
  if (name === "computer_move") {
    return compact({
      x: requiredNumber(arguments_, "x"),
      y: requiredNumber(arguments_, "y"),
      key: optionalString(arguments_, "key"),
    });
  }
  if (name === "computer_press_key") return { key: requiredString(arguments_, "key") };
  if (name === "computer_scroll") {
    const direction = requiredString(arguments_, "direction");
    if (!DIRECTIONS.has(direction)) throw new Error("direction is not supported");
    const pixels = optionalNumber(arguments_, "pixels");
    if (pixels != null && pixels <= 0) throw new Error("pixels must be greater than zero");
    return compact({
      direction,
      pixels,
      x: optionalNumber(arguments_, "x"),
      y: optionalNumber(arguments_, "y"),
      key: optionalString(arguments_, "key"),
    });
  }
  if (name === "computer_type_text") return { text: requiredString(arguments_, "text", { allowEmpty: true }) };
  throw new Error(`Unknown computer-use tool: ${name}`);
}

function helperCommand(name) {
  return ({
    computer_screenshot: "get_screenshot",
    computer_click: "click",
    computer_drag: "drag",
    computer_move: "move",
    computer_press_key: "press_key",
    computer_scroll: "scroll",
    computer_type_text: "type_text",
  })[name];
}

function runHelper(binary, command, input, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [command], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Computer Use ${command} timed out`));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Computer Use ${command} exited with code ${code}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export class ComputerUseController {
  constructor({ environment = process.env, platform = process.platform, invoke = runHelper } = {}) {
    this.environment = environment;
    this.platform = platform;
    this.invoke = invoke;
  }

  async binary() {
    if (this.platform !== "linux") throw new Error("This Computer Use adapter supports Linux only");
    if (!this.environment.DISPLAY) throw new Error("Computer Use needs an Xorg desktop (DISPLAY is not set)");
    if (this.environment.XDG_SESSION_TYPE?.toLowerCase() === "wayland" && this.environment.CHATGPT_COMPUTER_USE_ALLOW_XWAYLAND !== "1") {
      throw new Error("Native Wayland Computer Use is not available yet. Log in to an Xorg session to use desktop control.");
    }
    const binary = this.environment.CHATGPT_SKY_LINUX_BIN;
    if (!binary) throw new Error("The packaged Linux Computer Use helper is missing");
    await access(binary, constants.X_OK);
    return binary;
  }

  async call(name, arguments_) {
    const input = validateComputerArguments(name, arguments_);
    const command = helperCommand(name);
    const output = await this.invoke(await this.binary(), command, input, this.environment);
    if (name === "computer_screenshot") return await screenshotResult(output);
    await delay(100);
    return { content: [{ type: "text", text: "ok" }] };
  }
}

async function screenshotResult(output) {
  let screenshots;
  try {
    screenshots = JSON.parse(output);
  } catch {
    throw new Error("Computer Use returned an invalid screenshot response");
  }
  if (!Array.isArray(screenshots) || screenshots.length === 0) throw new Error("Computer Use returned no screenshots");
  const content = [];
  for (const [index, screenshot] of screenshots.entries()) {
    if (typeof screenshot?.filepath !== "string" || !screenshot.filepath) {
      throw new Error("Computer Use returned an invalid screenshot path");
    }
    const bytes = await readFile(screenshot.filepath);
    content.push({ type: "text", text: `Display ${index + 1}` });
    content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" });
    await rm(screenshot.filepath, { force: true });
  }
  return { content };
}

const coordinate = { type: "number" };
const key = { type: "string", description: "X11 key or + separated chord, for example Ctrl+l or Return" };

export const computerUseTools = [
  { name: "computer_screenshot", description: "Capture every display in the current Xorg desktop.", inputSchema: { type: "object", properties: {} } },
  { name: "computer_click", description: "Click a desktop coordinate from the latest screenshot.", inputSchema: { type: "object", properties: { x: coordinate, y: coordinate, mouse_button: { enum: [...MOUSE_BUTTONS] }, click_count: { type: "integer", minimum: 1, maximum: 3 }, key }, required: ["x", "y"] } },
  { name: "computer_drag", description: "Drag between desktop coordinates.", inputSchema: { type: "object", properties: { from_x: coordinate, from_y: coordinate, to_x: coordinate, to_y: coordinate, key }, required: ["from_x", "from_y", "to_x", "to_y"] } },
  { name: "computer_move", description: "Move the pointer to a desktop coordinate.", inputSchema: { type: "object", properties: { x: coordinate, y: coordinate, key }, required: ["x", "y"] } },
  { name: "computer_press_key", description: "Press an X11 key or keyboard chord.", inputSchema: { type: "object", properties: { key }, required: ["key"] } },
  { name: "computer_scroll", description: "Scroll the desktop, optionally at a coordinate.", inputSchema: { type: "object", properties: { direction: { enum: [...DIRECTIONS] }, pixels: { type: "number", exclusiveMinimum: 0 }, x: coordinate, y: coordinate, key }, required: ["direction"] } },
  { name: "computer_type_text", description: "Type text into the currently focused desktop control.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

export function createComputerUseServer(controller = new ComputerUseController()) {
  return new McpServer({
    name: "chatgpt-linux-computer-use",
    version: "1.0.0",
    tools: computerUseTools,
    callTool: (name, arguments_) => controller.call(name, arguments_),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveStdio(createComputerUseServer());
}
