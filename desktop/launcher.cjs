const { app, dialog, Notification, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const portPackage = require("./package.json");

const analysisRoot = path.resolve(__dirname, "..");
const packagedVendorApp = path.join(__dirname, "vendor-app");
const extractedApp = fs.existsSync(packagedVendorApp)
  ? packagedVendorApp
  : path.join(analysisRoot, "extracted", "app-asar");
const linuxRuntime = fs.existsSync(packagedVendorApp)
  ? path.join(__dirname, "..", "linux-runtime")
  : path.join(__dirname, "linux-runtime");
const { installLinuxMainBundlePatches } = require(path.join(linuxRuntime, "main-bundle-patches.cjs"));
const { installNotificationIntegration } = require(path.join(linuxRuntime, "notifications.cjs"));
const { prepareChromeNativeHost } = require(path.join(linuxRuntime, "chrome-native-host.cjs"));
const systemCodex =
  process.env.CODEX_CLI_PATH ||
  process.env.CODEX_DESKTOP_CODEX_PATH ||
  "";
const packagedCodex = path.join(analysisRoot, "codex");
const linuxCodex = fs.existsSync(packagedCodex) ? packagedCodex : systemCodex;

// Match the normal Codex profile unless an isolated test profile is requested.
if (process.env.CODEX_DESKTOP_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.CODEX_DESKTOP_DEBUG_PORT);
}
app.setName("ChatGPT");
app.setDesktopName("chatgpt.desktop");
app.setVersion(portPackage.version);
Object.defineProperty(app, "isPackaged", { value: true });
process.env.CODEX_HOME ||=
  process.env.CODEX_DESKTOP_ISOLATED_STATE === "1"
    ? path.join(analysisRoot, "desktop", "state", "codex-home")
    : path.join(os.homedir(), ".codex");
if (systemCodex) process.env.CHATGPT_LINUX_SYSTEM_CODEX = systemCodex;
process.env.CODEX_INSTALL_DIR ||= path.dirname(systemCodex || linuxCodex);
process.env.CODEX_CLI_PATH = linuxCodex;
process.env.CODEX_DESKTOP_CODEX_PATH = linuxCodex;
// Linux packages are updated by their package manager, never by the macOS updater.
process.env.CODEX_SPARKLE_ENABLED = "false";
process.env.ELECTRON_IS_DEV = "0";
process.env.BUILD_FLAVOR = "prod";
process.env.CODEX_BUILD_NUMBER = portPackage.codexBuildNumber;
process.env.NODE_ENV = "production";

try {
  prepareChromeNativeHost({ resourcesPath: analysisRoot });
} catch (error) {
  console.warn(`[chatgpt-linux] Could not prepare the Chrome native host: ${error instanceof Error ? error.message : String(error)}`);
}

if (process.env.CODEX_DESKTOP_ISOLATED_STATE === "1") {
  app.setPath("userData", path.join(analysisRoot, "desktop", "state", "electron-user-data"));
}

if (process.env.CODEX_DESKTOP_DEBUG_PORT) {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("did-fail-load", (_e, code, description, url) => {
      console.error("[renderer:did-fail-load]", { code, description, url });
    });
    contents.on("console-message", (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    contents.on("render-process-gone", (_e, details) => {
      console.error("[renderer:gone]", details);
    });
  });
}

installNotificationIntegration({ Notification, shell, dialog });
installLinuxMainBundlePatches(extractedApp);
require(path.join(extractedApp, ".vite", "build", "early-bootstrap.js"));
