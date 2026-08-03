const path = require("node:path");
const { writeFile } = require("node:fs/promises");

const packageRoot = process.env.CODEX_DESKTOP_PACKAGE_ROOT || "/opt/chatgpt";
const vendorModules = process.env.CODEX_DESKTOP_VENDOR_MODULES ||
  path.join(packageRoot, "resources", "app", "vendor-app", "node_modules");

function fail(error) {
  console.error(error?.stack || error);
  process.exit(1);
}

async function sqliteProbe(databasePath, operation) {
  const Database = require(path.join(vendorModules, "better-sqlite3"));
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec("CREATE TABLE IF NOT EXISTS port_probe (value TEXT NOT NULL)");
  if (operation === "write") {
    database.prepare("DELETE FROM port_probe").run();
    database.prepare("INSERT INTO port_probe (value) VALUES (?)").run("persisted-through-electron");
  } else {
    const row = database.prepare("SELECT value FROM port_probe").get();
    if (row?.value !== "persisted-through-electron") throw new Error(`Unexpected SQLite row: ${JSON.stringify(row)}`);
  }
  database.close();
}

async function ptyProbe() {
  const pty = require(path.join(vendorModules, "node-pty"));
  await new Promise((resolve, reject) => {
    const terminal = pty.spawn("/bin/sh", ["-c", "printf port-pty-output; exit 7"], {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    let output = "";
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error("PTY did not exit"));
    }, 5_000);
    terminal.onData(data => { output += data; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      try {
        if (!output.includes("port-pty-output")) throw new Error(`Missing PTY output: ${JSON.stringify(output)}`);
        if (exitCode !== 7) throw new Error(`Unexpected PTY exit code: ${exitCode}`);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function ptyKillProbe() {
  const pty = require(path.join(vendorModules, "node-pty"));
  await new Promise((resolve, reject) => {
    const terminal = pty.spawn("/bin/sh", ["-c", "printf ready-to-cancel; sleep 30"], {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    const timeout = setTimeout(() => {
      terminal.kill("SIGKILL");
      reject(new Error("Cancelled PTY did not exit"));
    }, 5_000);
    terminal.onData(data => {
      if (data.includes("ready-to-cancel")) terminal.kill();
    });
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timeout);
      if (exitCode === 0 && signal === 0) reject(new Error("Cancelled PTY reported successful completion"));
      else resolve();
    });
  });
}

async function watcherProbe(directory) {
  const watcher = require(path.join(vendorModules, "@parcel", "watcher"));
  const { promise, resolve, reject } = Promise.withResolvers();
  const timeout = setTimeout(() => reject(new Error("Watcher did not report the created file")), 5_000);
  let subscription;
  try {
    subscription = await watcher.subscribe(directory, (error, events) => {
      if (error) reject(error);
      else if (events.some(event => event.path.endsWith("port-watcher-output"))) resolve();
    });
    await writeFile(path.join(directory, "port-watcher-output"), "watched");
    await promise;
  } finally {
    clearTimeout(timeout);
    await subscription?.unsubscribe();
  }
}

function desktopProbe() {
  const { Notification, app } = require("electron");
  if (!Notification.isSupported()) throw new Error("Electron notifications are unavailable");
  if (!app.isDefaultProtocolClient("codex")) throw new Error("codex:// is not registered for this package");
}

const [probe, ...arguments_] = process.argv.slice(2);
const task = probe === "sqlite"
  ? sqliteProbe(arguments_[0], arguments_[1])
  : probe === "pty"
    ? ptyProbe()
    : probe === "pty-kill"
      ? ptyKillProbe()
      : probe === "watcher"
        ? watcherProbe(arguments_[0])
        : probe === "desktop"
          ? app.whenReady().then(desktopProbe).finally(() => app.quit())
        : Promise.reject(new Error(`Unknown native probe: ${probe}`));
task.catch(fail);
