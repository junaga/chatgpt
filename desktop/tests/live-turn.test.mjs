import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchPackagedApp, terminate, waitForLog } from "./helpers/app-driver.mjs";

const enabled = process.env.CODEX_LIVE_TEST === "1";
const timeout = Number(process.env.CODEX_LIVE_TEST_TIMEOUT || 300_000);

test("authenticated app completes a file edit through the Linux Codex backend", {
  skip: enabled ? false : "set CODEX_LIVE_TEST=1; this test consumes account usage and creates a remote thread",
  timeout: timeout + 10_000,
}, async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "chatgpt-linux-live-"));
  const project = path.join(temporaryRoot, "project");
  const userData = path.join(temporaryRoot, "electron-profile");
  const outputPath = path.join(project, "port-live-test.txt");
  const codexHome = process.env.CODEX_LIVE_CODEX_HOME || path.join(os.homedir(), ".codex");
  const init = spawnSync("git", ["init", "--quiet", project], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  await writeFile(path.join(project, "README.md"), "# Disposable live port test\n");

  const app = await launchPackagedApp({ project, userData, codexHome, timeout: 60_000 });
  t.after(async () => {
    await terminate(app.child);
    if (process.env.CODEX_LIVE_KEEP_ARTIFACTS !== "1") {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } else {
      console.error(`Kept live-test project at ${temporaryRoot}`);
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
  assert.equal(actual?.trim(), expected, `The expected edit did not complete.\n${app.logs().slice(-4_000)}`);

  const status = spawnSync("git", ["status", "--short", "--", "port-live-test.txt"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.trim(), "?? port-live-test.txt");
});
