import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestWorkspace, launchPackagedApp, terminate, waitForLog } from "./helpers/app-driver.mjs";

const startupTimeout = Number(process.env.CODEX_DESKTOP_TEST_TIMEOUT || 60_000);
const packageRoot = process.env.CODEX_DESKTOP_PACKAGE_ROOT || "/opt/chatgpt";

test("packaged Linux app starts, mounts its renderer, and opens a Git project", { timeout: startupTimeout + 10_000 }, async t => {
  const sandbox = await stat(path.join(packageRoot, "chrome-sandbox"));
  if (process.env.CODEX_DESKTOP_PACKAGE_ROOT) {
    assert.equal(sandbox.mode & 0o755, 0o755, "Unpacked Chromium sandbox must be executable");
  } else {
    assert.equal(sandbox.uid, 0, "Installed Chromium sandbox must be owned by root");
    assert.equal(sandbox.mode & 0o4777, 0o4755, "Installed Chromium sandbox must be setuid and executable");
  }

  const workspace = await createTestWorkspace("chatgpt-linux-test-");

  const { browser, child, deadline, logs, page } = await launchPackagedApp({
    project: workspace.project,
    userData: workspace.userData,
    codexHome: workspace.codexHome,
    timeout: startupTimeout,
  });

  t.after(async () => {
    await terminate(child);
    await workspace.remove();
  });

  await waitForLog(logs, /app routes mounted/, deadline);

  assert.equal(await page.title(), "Codex");
  assert.match(page.url(), /^app:\/\/-\/index\.html/);
  assert.equal(await page.locator("#root").count(), 1);
  assert.equal(child.spawnargs.includes("--no-sandbox"), false);
  assert.ok(child.spawnargs.includes(workspace.project));
});
