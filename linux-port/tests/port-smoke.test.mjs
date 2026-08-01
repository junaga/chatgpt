import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const executable = process.env.CODEX_DESKTOP_EXECUTABLE || "/usr/bin/codex-desktop";
const startupTimeout = Number(process.env.CODEX_DESKTOP_TEST_TIMEOUT || 60_000);

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function boundedCollector(stream, limit = 2 * 1024 * 1024) {
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    output = (output + chunk).slice(-limit);
  });
  return () => output;
}

async function connect(port, deadline) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error("DevTools endpoint did not become available");
}

async function waitForLog(readLogs, pattern, deadline) {
  while (Date.now() < deadline) {
    if (pattern.test(readLogs())) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(readLogs(), pattern);
}

async function terminate(child) {
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

test("packaged Linux app starts, mounts its renderer, and opens a Git project", { timeout: startupTimeout + 10_000 }, async t => {
  const sandbox = await stat("/opt/codex-desktop-linux/chrome-sandbox");
  assert.equal(sandbox.uid, 0, "Chromium sandbox must be owned by root");
  assert.equal(sandbox.mode & 0o4777, 0o4755, "Chromium sandbox must be setuid and executable");

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "chatgpt-linux-test-"));
  const project = path.join(temporaryRoot, "project");
  const userData = path.join(temporaryRoot, "electron-profile");
  const codexHome = path.join(temporaryRoot, "codex-home");
  await writeFile(path.join(temporaryRoot, "placeholder"), "");
  const init = spawnSync("git", ["init", "--quiet", project], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  await writeFile(path.join(project, "README.md"), "# Port smoke-test fixture\n");

  const port = await reservePort();
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    "--open-project",
    project,
  ], {
    detached: true,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_DESKTOP_DEBUG_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = boundedCollector(child.stdout);
  const stderr = boundedCollector(child.stderr);

  t.after(async () => {
    await terminate(child);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const deadline = Date.now() + startupTimeout;
  const browser = await connect(port, deadline);

  let page;
  while (Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages())
      .find(candidate => candidate.url().startsWith("app://-") && !candidate.url().includes("initialRoute="));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(page, `No app renderer appeared.\nstdout:\n${stdout()}\nstderr:\n${stderr()}`);
  const logs = () => `${stdout()}\n${stderr()}`;
  await waitForLog(logs, /app routes mounted/, deadline);

  assert.equal(await page.title(), "Codex");
  assert.match(page.url(), /^app:\/\/-\/index\.html/);
  assert.equal(await page.locator("#root").count(), 1);
  assert.equal(child.spawnargs.includes("--no-sandbox"), false);
  assert.ok(child.spawnargs.includes(project));
});
