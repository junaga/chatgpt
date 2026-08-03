import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer, serveStdio } from "./mcp-server.mjs";

const KNOWN_BROWSERS = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "microsoft-edge-stable",
  "microsoft-edge",
  "brave-browser",
  "vivaldi-stable",
  "vivaldi",
];
const CHROMIUM_NAME = /(chrom(?:e|ium)|edge|brave|vivaldi)/i;
const MAX_SNAPSHOT_LENGTH = 60_000;

function firstCommand(value) {
  const trimmed = value.trim().replace(/%[sSuU]/g, "").trim();
  const match = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return match?.[1] || match?.[2] || match?.[3] || "";
}

export function browserEnvironmentCandidates(value) {
  if (!value?.trim()) return [];
  return value.split(":").map(firstCommand).filter(Boolean);
}

async function executablePath(command, environment) {
  if (!command || !CHROMIUM_NAME.test(path.basename(command))) return null;
  if (path.isAbsolute(command)) {
    try {
      await access(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const directory of (environment.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

function commandOutput(command, arguments_, environment) {
  return new Promise(resolve => {
    const child = spawn(command, arguments_, { env: environment, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.on("error", () => resolve(""));
    child.on("close", code => resolve(code === 0 ? output.trim() : ""));
  });
}

async function desktopEntryCommand(filename, environment) {
  if (!filename.endsWith(".desktop") || filename.includes("/")) return "";
  const roots = [
    environment.XDG_DATA_HOME && path.join(environment.XDG_DATA_HOME, "applications"),
    path.join(os.homedir(), ".local", "share", "applications"),
    ...(environment.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
      .split(":")
      .filter(Boolean)
      .map(root => path.join(root, "applications")),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      const entry = await readFile(path.join(root, filename), "utf8");
      const execLine = entry.match(/^Exec=(.+)$/m)?.[1];
      if (execLine) return firstCommand(execLine);
    } catch {
      // Try the next XDG data directory.
    }
  }
  return "";
}

export async function findBrowserExecutable(environment = process.env) {
  for (const command of browserEnvironmentCandidates(environment.BROWSER)) {
    const resolved = await executablePath(command, environment);
    if (resolved) return { path: resolved, source: "BROWSER" };
  }

  const desktopFile = await commandOutput("xdg-settings", ["get", "default-web-browser"], environment);
  const defaultCommand = desktopFile ? await desktopEntryCommand(desktopFile, environment) : "";
  const defaultPath = await executablePath(defaultCommand, environment);
  if (defaultPath) return { path: defaultPath, source: "xdg-settings" };

  for (const command of KNOWN_BROWSERS) {
    const resolved = await executablePath(command, environment);
    if (resolved) return { path: resolved, source: "known-command" };
  }
  throw new Error("No supported Chromium browser found. Set BROWSER to Chrome, Chromium, Edge, Brave, or Vivaldi.");
}

function validateUrl(value) {
  if (value == null || value === "") return "about:blank";
  if (typeof value !== "string") throw new Error("url must be a string");
  if (value === "about:blank") return value;
  const parsed = new URL(value);
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
    throw new Error("Browser navigation supports only http, https, and file URLs");
  }
  return parsed.href;
}

function requiredString(arguments_, key) {
  const value = arguments_[key];
  if (typeof value !== "string" || !value.length) throw new Error(`${key} must be a non-empty string`);
  return value;
}

export class BrowserController {
  constructor({ environment = process.env, loadChromium } = {}) {
    this.environment = environment;
    this.loadChromium = loadChromium || (() => loadPackagedChromium(environment));
    this.context = null;
    this.selectedPage = null;
    this.browserInfo = null;
  }

  async ensureContext() {
    if (this.context) return this.context;
    const executable = await findBrowserExecutable(this.environment);
    const chromium = await this.loadChromium();
    const stateRoot = this.environment.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
    const profile = this.environment.CHATGPT_BROWSER_PROFILE || path.join(stateRoot, "chatgpt", "browser-profile");
    await mkdir(profile, { recursive: true });
    this.context = await chromium.launchPersistentContext(profile, {
      executablePath: executable.path,
      headless: false,
      viewport: null,
      acceptDownloads: true,
      args: ["--start-maximized"],
    });
    this.browserInfo = executable;
    this.selectedPage = this.context.pages().at(-1) || await this.context.newPage();
    this.context.on("page", page => { this.selectedPage = page; });
    return this.context;
  }

  async page() {
    const context = await this.ensureContext();
    if (!this.selectedPage || this.selectedPage.isClosed()) {
      this.selectedPage = context.pages().at(-1) || await context.newPage();
    }
    return this.selectedPage;
  }

  async locator(arguments_) {
    const page = await this.page();
    let locator;
    if (typeof arguments_.selector === "string" && arguments_.selector) {
      locator = page.locator(arguments_.selector);
    } else if (typeof arguments_.role === "string" && typeof arguments_.name === "string") {
      locator = page.getByRole(arguments_.role, { name: arguments_.name, exact: arguments_.exact === true });
    } else if (typeof arguments_.text === "string" && arguments_.text) {
      locator = page.getByText(arguments_.text, { exact: arguments_.exact === true });
    } else {
      throw new Error("Provide selector, text, or both role and name");
    }
    const index = arguments_.index ?? 0;
    if (!Number.isInteger(index) || index < 0) throw new Error("index must be a non-negative integer");
    return locator.nth(index);
  }

  async call(name, arguments_) {
    if (name === "browser_open") {
      const page = await this.page();
      const url = validateUrl(arguments_.url);
      if (url !== "about:blank" || page.url() === "about:blank") await page.goto(url);
      return textResult({ browser: this.browserInfo, title: await page.title(), url: page.url() });
    }
    if (name === "browser_snapshot") {
      const page = await this.page();
      let snapshot;
      try {
        snapshot = await page.locator("body").ariaSnapshot({ timeout: 10_000 });
      } catch {
        snapshot = await page.locator("body").innerText({ timeout: 10_000 });
      }
      if (snapshot.length > MAX_SNAPSHOT_LENGTH) snapshot = `${snapshot.slice(0, MAX_SNAPSHOT_LENGTH)}\n[truncated]`;
      return textResult({ title: await page.title(), url: page.url(), snapshot });
    }
    if (name === "browser_click") {
      await (await this.locator(arguments_)).click();
      return textResult({ ok: true, url: (await this.page()).url() });
    }
    if (name === "browser_type") {
      const locator = await this.locator(arguments_);
      await locator.fill(requiredString(arguments_, "value"));
      if (arguments_.submit === true) await locator.press("Enter");
      return textResult({ ok: true });
    }
    if (name === "browser_press") {
      await (await this.page()).keyboard.press(requiredString(arguments_, "key"));
      return textResult({ ok: true });
    }
    if (name === "browser_screenshot") {
      const page = await this.page();
      const data = await page.screenshot({ type: "png", fullPage: arguments_.full_page === true });
      return { content: [
        { type: "text", text: JSON.stringify({ title: await page.title(), url: page.url() }) },
        { type: "image", data: data.toString("base64"), mimeType: "image/png" },
      ] };
    }
    if (name === "browser_tabs") return await this.tabs(arguments_);
    throw new Error(`Unknown browser tool: ${name}`);
  }

  async tabs(arguments_) {
    const context = await this.ensureContext();
    const action = arguments_.action || "list";
    if (action === "new") {
      this.selectedPage = await context.newPage();
      await this.selectedPage.goto(validateUrl(arguments_.url));
    } else if (action === "select") {
      const index = arguments_.index;
      if (!Number.isInteger(index) || !context.pages()[index]) throw new Error("index does not name an open tab");
      this.selectedPage = context.pages()[index];
      await this.selectedPage.bringToFront();
    } else if (action === "close") {
      const index = arguments_.index;
      if (!Number.isInteger(index) || !context.pages()[index]) throw new Error("index does not name an open tab");
      await context.pages()[index].close();
      this.selectedPage = context.pages().at(-1) || await context.newPage();
    } else if (action !== "list") {
      throw new Error("action must be list, new, select, or close");
    }
    const pages = await Promise.all(context.pages().map(async (page, index) => ({
      index,
      selected: page === this.selectedPage,
      title: await page.title(),
      url: page.url(),
    })));
    return textResult({ tabs: pages });
  }

  async close() {
    await this.context?.close();
    this.context = null;
  }
}

async function loadPackagedChromium(environment) {
  if (environment.CHATGPT_APP_ROOT) {
    const modulePath = path.join(environment.CHATGPT_APP_ROOT, "node_modules", "playwright-core", "index.mjs");
    return (await import(pathToFileURL(modulePath).href)).chromium;
  }
  return (await import("playwright-core")).chromium;
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const locatorProperties = {
  selector: { type: "string", description: "CSS selector" },
  role: { type: "string", description: "Accessible role, used with name" },
  name: { type: "string", description: "Accessible name, used with role" },
  text: { type: "string", description: "Visible text" },
  exact: { type: "boolean" },
  index: { type: "integer", minimum: 0, default: 0 },
};

export const browserTools = [
  { name: "browser_open", description: "Start the visible Linux browser and optionally navigate it.", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "browser_snapshot", description: "Read the current page as an accessibility snapshot.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_click", description: "Click an element located by accessible role/name, visible text, or CSS selector.", inputSchema: { type: "object", properties: locatorProperties } },
  { name: "browser_type", description: "Fill an element and optionally press Enter.", inputSchema: { type: "object", properties: { ...locatorProperties, value: { type: "string" }, submit: { type: "boolean" } }, required: ["value"] } },
  { name: "browser_press", description: "Press a keyboard key or chord in the current page.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "browser_screenshot", description: "Capture the current page as PNG.", inputSchema: { type: "object", properties: { full_page: { type: "boolean" } } } },
  { name: "browser_tabs", description: "List, create, select, or close browser tabs.", inputSchema: { type: "object", properties: { action: { enum: ["list", "new", "select", "close"] }, index: { type: "integer", minimum: 0 }, url: { type: "string" } } } },
];

export function createBrowserServer(controller = new BrowserController()) {
  return new McpServer({
    name: "chatgpt-linux-browser",
    version: "1.0.0",
    tools: browserTools,
    callTool: (name, arguments_) => controller.call(name, arguments_),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new BrowserController();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void controller.close().finally(() => process.exit(0)));
  }
  serveStdio(createBrowserServer(controller));
}
