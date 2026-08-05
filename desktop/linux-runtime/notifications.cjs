const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_ENTRY_ID = "chatgpt";
const GNOME_PERMISSION_APP_ID = "chatgpt";
const UPSTREAM_NOTIFICATION_SETTINGS_URI =
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.openai.codex";

const SETTINGS_COMMANDS = Object.freeze({
  cinnamon: [
    { command: "cinnamon-settings", arguments: ["notifications"] },
  ],
  gnome: [
    { command: "gnome-control-center", arguments: ["notifications"] },
  ],
  kde: [
    {
      command: "systemsettings",
      arguments: ["kcm_notifications", "--args", `--desktop-entry ${DESKTOP_ENTRY_ID}`],
    },
    {
      command: "kcmshell6",
      arguments: ["kcm_notifications", "--args", `--desktop-entry ${DESKTOP_ENTRY_ID}`],
    },
  ],
  xfce: [
    { command: "xfce4-notifyd-config", arguments: [] },
  ],
});

function desktopFamily(environment = process.env) {
  const desktop = [
    environment.XDG_CURRENT_DESKTOP,
    environment.XDG_SESSION_DESKTOP,
    environment.DESKTOP_SESSION,
  ]
    .filter(Boolean)
    .join(":")
    .toLowerCase();

  // Cinnamon historically identifies itself as X-Cinnamon and may include
  // GNOME compatibility names, so match the more specific families first.
  if (desktop.includes("cinnamon")) return "cinnamon";
  if (desktop.includes("plasma") || desktop.includes("kde")) return "kde";
  if (desktop.includes("xfce")) return "xfce";
  if (
    desktop.includes("gnome") ||
    desktop.includes("unity") ||
    desktop.includes("pantheon")
  ) {
    return "gnome";
  }
  return null;
}

function executableOnPath(command, {
  environment = process.env,
  isExecutable = defaultIsExecutable,
} = {}) {
  if (command.includes(path.sep)) return isExecutable(command) ? command : null;
  for (const directory of (environment.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function defaultIsExecutable(filename) {
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveNotificationSettings({
  environment = process.env,
  isExecutable = defaultIsExecutable,
} = {}) {
  const family = desktopFamily(environment);
  const families = family ? [family] : ["gnome", "kde", "xfce", "cinnamon"];

  for (const name of families) {
    for (const candidate of SETTINGS_COMMANDS[name]) {
      const executable = executableOnPath(candidate.command, { environment, isExecutable });
      if (executable) {
        return { executable, arguments: [...candidate.arguments], family: name };
      }
    }
  }
  return null;
}

async function showSettingsUnavailable(dialog) {
  if (typeof dialog?.showMessageBox !== "function") return;
  await dialog.showMessageBox({
    type: "info",
    message: "Open your desktop notification settings",
    detail: "This desktop does not provide a known notification-settings command. Notifications from ChatGPT still work.",
    buttons: ["OK"],
  });
}

async function openLinuxNotificationSettings({
  environment = process.env,
  isExecutable = defaultIsExecutable,
  spawn = childProcess.spawn,
  dialog,
  logger = console,
} = {}) {
  const resolved = resolveNotificationSettings({ environment, isExecutable });
  if (!resolved) {
    await showSettingsUnavailable(dialog);
    return false;
  }

  try {
    const child = spawn(resolved.executable, resolved.arguments, {
      detached: true,
      env: environment,
      shell: false,
      stdio: "ignore",
    });
    child.once?.("error", error => {
      logger.warn?.("Unable to open Linux notification settings", error);
    });
    child.unref?.();
    return true;
  } catch (error) {
    logger.warn?.("Unable to open Linux notification settings", error);
    await showSettingsUnavailable(dialog);
    return false;
  }
}

function parseGnomePermissionStore(output, appId = GNOME_PERMISSION_APP_ID) {
  if (typeof output !== "string") return undefined;
  const escapedId = appId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(
    new RegExp(`["']${escapedId}["']\\s*:\\s*\\[\\s*["'](yes|no)["']`),
  );
  if (match?.[1] === "yes") return "granted";
  if (match?.[1] === "no") return "denied";
  return undefined;
}

function execFileText(executable, arguments_, { environment, execFile = childProcess.execFile }) {
  return new Promise(resolve => {
    execFile(
      executable,
      arguments_,
      { encoding: "utf8", env: environment, timeout: 2_000, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

async function getLinuxNotificationPermissionStatus({
  environment = process.env,
  isExecutable = defaultIsExecutable,
  execFile = childProcess.execFile,
  appId = GNOME_PERMISSION_APP_ID,
} = {}) {
  // Other desktops have no stable permission query. Returning undefined makes
  // upstream report an unknown status rather than incorrectly claiming that
  // notifications are allowed or denied.
  if (desktopFamily(environment) !== "gnome") return undefined;

  const gdbus = executableOnPath("gdbus", { environment, isExecutable });
  if (!gdbus) return undefined;
  const output = await execFileText(
    gdbus,
    [
      "call",
      "--session",
      "--dest", "org.freedesktop.impl.portal.PermissionStore",
      "--object-path", "/org/freedesktop/impl/portal/PermissionStore",
      "--method", "org.freedesktop.impl.portal.PermissionStore.Lookup",
      "notifications",
      "notification",
    ],
    { environment, execFile },
  );
  return parseGnomePermissionStore(output, appId);
}

function installNotificationIntegration({
  Notification,
  shell,
  dialog,
  environment = process.env,
  isExecutable = defaultIsExecutable,
  spawn = childProcess.spawn,
  execFile = childProcess.execFile,
  logger = console,
} = {}) {
  if (!Notification || !shell || typeof shell.openExternal !== "function") {
    throw new TypeError("Electron Notification and shell APIs are required");
  }

  const originalOpenExternal = shell.openExternal.bind(shell);
  if (typeof Notification.getPermissionStatus !== "function") {
    Object.defineProperty(Notification, "getPermissionStatus", {
      configurable: true,
      value: () => getLinuxNotificationPermissionStatus({ environment, isExecutable, execFile }),
    });
  }

  shell.openExternal = (url, options) => {
    if (url !== UPSTREAM_NOTIFICATION_SETTINGS_URI) {
      return originalOpenExternal(url, options);
    }
    return openLinuxNotificationSettings({
      environment,
      isExecutable,
      spawn,
      dialog,
      logger,
    }).then(() => undefined);
  };

  return () => {
    shell.openExternal = originalOpenExternal;
  };
}

const SYSTEM_PERMISSIONS_GUARD =
  "systemPermissions:process.platform===`darwin`||process.platform===`win32`&&js()?";
const LINUX_SYSTEM_PERMISSIONS_GUARD =
  "systemPermissions:process.platform===`darwin`||process.platform===`linux`||process.platform===`win32`&&js()?";

function enableLinuxSystemPermissions(source) {
  const first = source.indexOf(SYSTEM_PERMISSIONS_GUARD);
  if (first === -1 || source.indexOf(SYSTEM_PERMISSIONS_GUARD, first + 1) !== -1) {
    throw new Error("Expected exactly one upstream system-permissions platform guard");
  }
  return source.replace(SYSTEM_PERMISSIONS_GUARD, LINUX_SYSTEM_PERMISSIONS_GUARD);
}

module.exports = {
  GNOME_PERMISSION_APP_ID,
  SETTINGS_COMMANDS,
  UPSTREAM_NOTIFICATION_SETTINGS_URI,
  desktopFamily,
  enableLinuxSystemPermissions,
  executableOnPath,
  getLinuxNotificationPermissionStatus,
  installNotificationIntegration,
  openLinuxNotificationSettings,
  parseGnomePermissionStore,
  resolveNotificationSettings,
};
