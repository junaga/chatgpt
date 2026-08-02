const { app } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const portPackage = require("./package.json");

const analysisRoot = path.resolve(__dirname, "..");
const packagedVendorApp = path.join(__dirname, "vendor-app");
const extractedApp = fs.existsSync(packagedVendorApp)
  ? packagedVendorApp
  : path.join(analysisRoot, "extracted", "app-asar");
const linuxCodex =
  process.env.CODEX_CLI_PATH ||
  process.env.CODEX_DESKTOP_CODEX_PATH ||
  "/usr/local/bin/codex";

// Match the normal Codex profile unless an isolated test profile is requested.
if (process.env.CODEX_DESKTOP_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.CODEX_DESKTOP_DEBUG_PORT);
}
app.setName("ChatGPT (Linux Compat)");
app.setVersion(portPackage.version);
Object.defineProperty(app, "isPackaged", { value: true });
process.env.CODEX_HOME ||=
  process.env.CODEX_DESKTOP_ISOLATED_STATE === "1"
    ? path.join(analysisRoot, "linux-port", "state", "codex-home")
    : path.join(os.homedir(), ".codex");
process.env.CODEX_INSTALL_DIR ||= path.dirname(linuxCodex);
process.env.CODEX_CLI_PATH = linuxCodex;
process.env.CODEX_DESKTOP_CODEX_PATH = linuxCodex;
process.env.ELECTRON_IS_DEV = "0";
process.env.BUILD_FLAVOR = "prod";
process.env.CODEX_BUILD_NUMBER = portPackage.codexBuildNumber;
process.env.NODE_ENV = "production";

if (process.env.CODEX_DESKTOP_ISOLATED_STATE === "1") {
  app.setPath("userData", path.join(analysisRoot, "linux-port", "state", "electron-user-data"));
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

require(path.join(extractedApp, ".vite", "build", "early-bootstrap.js"));
