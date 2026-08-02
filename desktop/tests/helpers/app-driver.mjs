import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { chromium } from "playwright-core";

const packageRoot = process.env.CODEX_DESKTOP_PACKAGE_ROOT;
const executable = process.env.CODEX_DESKTOP_EXECUTABLE ||
  (packageRoot ? `${packageRoot}/codex-desktop` : "/usr/bin/codex-desktop");

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

function collect(stream, limit = 2 * 1024 * 1024) {
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => { output = (output + chunk).slice(-limit); });
  return () => output;
}

export async function terminate(child) {
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  // The main process can exit before zygote/app-server descendants finish.
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
}

export async function launchPackagedApp({ project, userData, codexHome, timeout = 60_000 }) {
  const port = await reservePort();
  const sandboxArguments = packageRoot ? ["--disable-setuid-sandbox"] : [];
  const child = spawn(executable, [...sandboxArguments, `--user-data-dir=${userData}`, "--open-project", project], {
    detached: true,
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_DESKTOP_DEBUG_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const logs = () => `${stdout()}\n${stderr()}`;
  const deadline = Date.now() + timeout;
  try {
    let browser;
    let lastError;
    while (Date.now() < deadline) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        break;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    if (!browser) throw lastError || new Error("DevTools endpoint did not become available");

    let page;
    while (Date.now() < deadline) {
      page = browser.contexts().flatMap(context => context.pages())
        .find(candidate => candidate.url().startsWith("app://-") && !candidate.url().includes("initialRoute="));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(page, `No app renderer appeared.\n${logs()}`);
    return { browser, child, deadline, logs, page };
  } catch (error) {
    await terminate(child);
    throw error;
  }
}

export async function waitForLog(readLogs, pattern, deadline) {
  while (Date.now() < deadline) {
    if (pattern.test(readLogs())) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(readLogs(), pattern);
}
