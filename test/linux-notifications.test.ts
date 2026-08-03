import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const notifications = require("../desktop/linux-runtime/notifications.cjs");

const mockBin = "/mock/bin";
const environment = (desktop: string) => ({
  PATH: mockBin,
  XDG_CURRENT_DESKTOP: desktop,
});
const executable = (name: string) => (candidate: string) => candidate === path.join(mockBin, name);

test("notification settings resolve to the current Linux desktop without a shell", () => {
  const cases = [
    ["GNOME", "gnome-control-center", ["notifications"], "gnome"],
    ["KDE", "systemsettings", ["kcm_notifications", "--args", "--desktop-entry chatgpt"], "kde"],
    ["XFCE", "xfce4-notifyd-config", [], "xfce"],
    ["X-Cinnamon", "cinnamon-settings", ["notifications"], "cinnamon"],
  ] as const;

  for (const [desktop, command, arguments_, family] of cases) {
    assert.deepEqual(
      notifications.resolveNotificationSettings({
        environment: environment(desktop),
        isExecutable: executable(command),
      }),
      { executable: path.join(mockBin, command), arguments: arguments_, family },
    );
  }
});

test("KDE notification settings fall back to kcmshell6", () => {
  assert.deepEqual(
    notifications.resolveNotificationSettings({
      environment: environment("plasma"),
      isExecutable: executable("kcmshell6"),
    }),
    {
      executable: path.join(mockBin, "kcmshell6"),
      arguments: ["kcm_notifications", "--args", "--desktop-entry chatgpt"],
      family: "kde",
    },
  );
});

test("opening notification settings uses executable argv and explicitly disables shell parsing", async () => {
  let invocation: unknown;
  let detached = false;
  const opened = await notifications.openLinuxNotificationSettings({
    environment: environment("GNOME"),
    isExecutable: executable("gnome-control-center"),
    spawn(command: string, arguments_: string[], options: Record<string, unknown>) {
      invocation = { command, arguments_, options };
      return {
        once() {},
        unref() { detached = true; },
      };
    },
  });

  assert.equal(opened, true);
  assert.equal(detached, true);
  assert.deepEqual(invocation, {
    command: path.join(mockBin, "gnome-control-center"),
    arguments_: ["notifications"],
    options: {
      detached: true,
      env: environment("GNOME"),
      shell: false,
      stdio: "ignore",
    },
  });
});

test("only the exact upstream notification-settings URI is intercepted", async () => {
  const externalUrls: string[] = [];
  const spawned: string[] = [];
  const shell = {
    async openExternal(url: string) { externalUrls.push(url); },
  };
  class Notification {}

  const restore = notifications.installNotificationIntegration({
    Notification,
    shell,
    environment: environment("GNOME"),
    isExecutable: executable("gnome-control-center"),
    spawn(command: string) {
      spawned.push(command);
      return { once() {}, unref() {} };
    },
  });

  await shell.openExternal(notifications.UPSTREAM_NOTIFICATION_SETTINGS_URI);
  await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  await shell.openExternal("https://example.com/");
  restore();

  assert.deepEqual(spawned, [path.join(mockBin, "gnome-control-center")]);
  assert.deepEqual(externalUrls, [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "https://example.com/",
  ]);
});

test("GNOME permission-store replies map safely and other desktops remain unknown", async () => {
  assert.equal(
    notifications.parseGnomePermissionStore("({'chatgpt': ['yes'], 'other': ['no']}, <@ay []>)"),
    "granted",
  );
  assert.equal(notifications.parseGnomePermissionStore("({'chatgpt': ['no']}, <@ay []>)"), "denied");
  assert.equal(notifications.parseGnomePermissionStore("({'other': ['yes']}, <@ay []>)"), undefined);

  const status = await notifications.getLinuxNotificationPermissionStatus({
    environment: environment("GNOME"),
    isExecutable: executable("gdbus"),
    execFile(_command: string, arguments_: string[], _options: unknown, callback: Function) {
      assert.deepEqual(arguments_.slice(-2), ["notifications", "notification"]);
      callback(null, "({'chatgpt': ['yes']}, <@ay []>)");
    },
  });
  assert.equal(status, "granted");
  assert.equal(
    await notifications.getLinuxNotificationPermissionStatus({
      environment: environment("KDE"),
      isExecutable: () => true,
    }),
    undefined,
  );
});

test("the upstream notification service patch is narrow and assertion checked", () => {
  const guard = "systemPermissions:process.platform===`darwin`||process.platform===`win32`&&jf()?";
  const patched = notifications.enableLinuxSystemPermissions(`before ${guard} after`);
  assert.equal(
    patched,
    "before systemPermissions:process.platform===`darwin`||process.platform===`linux`||process.platform===`win32`&&jf()? after",
  );
  assert.throws(() => notifications.enableLinuxSystemPermissions("no guard"), /exactly one/);
  assert.throws(() => notifications.enableLinuxSystemPermissions(`${guard}${guard}`), /exactly one/);
});

test("launcher and desktop metadata establish Linux notification identity before startup", async () => {
  const launcher = await readFile(new URL("../desktop/launcher.cjs", import.meta.url), "utf8");
  const entry = await readFile(new URL("../desktop/packaging/chatgpt.desktop", import.meta.url), "utf8");
  assert.match(entry, /^X-GNOME-UsesNotifications=true$/m);
  assert.match(launcher, /app\.setDesktopName\("chatgpt\.desktop"\)/);
  assert.ok(
    launcher.indexOf("app.setDesktopName") < launcher.indexOf("early-bootstrap.js"),
    "desktop identity must be set before Electron startup",
  );
  assert.match(launcher, /installNotificationIntegration/);
  assert.match(launcher, /installLinuxMainBundlePatches/);
});
