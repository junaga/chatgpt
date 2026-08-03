import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteThreadsForCwd } from "./helpers/app-server.mjs";
import { createTestWorkspace, launchPackagedApp, terminate, waitForLog } from "./helpers/app-driver.mjs";

const enabled = process.env.CODEX_LIVE_TEST === "1";
const timeout = Number(process.env.CODEX_LIVE_TEST_TIMEOUT || 300_000);

test("authenticated app completes a file edit through the Linux Codex backend", {
  skip: enabled ? false : "set CODEX_LIVE_TEST=1; this test consumes account usage and creates then deletes a remote thread",
  timeout: timeout + 90_000,
}, async t => {
  const workspace = await createTestWorkspace("chatgpt-linux-live-");
  const outputPath = path.join(workspace.project, "port-live-test.txt");
  const codexHome = process.env.CODEX_LIVE_CODEX_HOME || path.join(os.homedir(), ".codex");

  const app = await launchPackagedApp({
    project: workspace.project,
    userData: workspace.userData,
    codexHome,
    timeout: 60_000,
  });
  let threadCreated = false;
  t.after(async () => {
    try {
      await terminate(app.child);
      if (threadCreated && process.env.CODEX_LIVE_KEEP_THREAD !== "1") {
        const deleted = await deleteThreadsForCwd({ codexHome, cwd: workspace.project });
        assert.ok(deleted.length > 0, `No live-test thread was found for ${workspace.project}`);
      }
    } catch (error) {
      throw new Error(
        `The live-test thread could not be deleted. Set CODEX_LIVE_KEEP_ARTIFACTS=1 ` +
        `and rerun to inspect the test project.\n${app.logs().slice(-4_000)}`,
        { cause: error },
      );
    } finally {
      if (process.env.CODEX_LIVE_KEEP_ARTIFACTS !== "1") {
        await workspace.remove();
      } else {
        console.error(`Kept live-test project at ${workspace.root}`);
      }
    }
  });
  await waitForLog(app.logs, /app routes mounted/, app.deadline);

  const composer = app.page.locator('textarea:visible, [contenteditable="true"]:visible').last();
  try {
    await composer.waitFor({ state: "visible", timeout: 30_000 });
  } catch (error) {
    const text = (await app.page.locator("body").innerText()).slice(0, 2_000);
    throw new Error(`No authenticated composer became visible. UI text:\n${text}`, { cause: error });
  }

  const expected = "chatgpt-linux live port test passed.";
  await composer.fill(
    `Create a file named port-live-test.txt in the current project containing exactly this one line: "${expected}" ` +
    "Do not modify any other file and do not run shell commands.",
  );
  const send = app.page.locator('button[aria-label*="send" i]:visible').last();
  if (await send.count()) await send.click();
  else await composer.press("Enter");
  threadCreated = true;

  const deadline = Date.now() + timeout;
  let actual;
  while (Date.now() < deadline) {
    for (const label of [/approve/i, /allow/i]) {
      const approval = app.page.getByRole("button", { name: label }).filter({ visible: true }).first();
      if (await approval.count()) await approval.click().catch(() => {});
    }
    try {
      actual = await readFile(outputPath, "utf8");
      if (actual.trim() === expected) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const visibleText = await app.page.locator("body").innerText().catch(() => "<renderer unavailable>");
  assert.equal(
    actual?.trim(),
    expected,
    `The expected edit did not complete.\nVisible UI:\n${visibleText.slice(-4_000)}\nLogs:\n${app.logs().slice(-4_000)}`,
  );

  const status = spawnSync("git", ["status", "--short", "--", "port-live-test.txt"], {
    cwd: workspace.project,
    encoding: "utf8",
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.trim(), "?? port-live-test.txt");
});
