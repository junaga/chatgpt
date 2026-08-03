import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  LINUX_CLIENT_SHA256,
  enableLinuxComputerUse,
} = require("../desktop/linux-runtime/computer-use.cjs");

const boundaries = [
  "let i=r===`win32`&&e.computerUse===!0?{...e,computerUseNodeRepl:!0}:e,o=r===`win32`&&n.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?{...i,computerUse:!0,computerUseNodeRepl:!0}:i",
  "isAvailable:({features:e,platform:t})=>t===`win32`&&e.computerUse",
  "function ou(e){if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}",
  "kr=[`028a14b6eaa6d98dac2aae00764345ab9f244801ed8493d42b9af3be5575006e`,`8785b5437d98636c3002d3d7e64b98db79c3b66870b1bd3d18dea953a99b1562`]",
  "let T=g||_&&(y.platform===`darwin`||w)?h:[]",
  "...r&&l.platform===`darwin`?{[ti]:Zee}:{}",
];

test("the upstream Computer Use feature, plugin, skill, and sandbox paths open on Linux", () => {
  const patched = enableLinuxComputerUse(boundaries.join(" separator "));
  assert.match(patched, /r===`linux`\?\{\.\.\.i,computerUse:!0,computerUseNodeRepl:!0\}/);
  assert.match(patched, /t===`win32`\|\|t===`linux`/);
  assert.match(patched, /e\.platform!==`darwin`&&e\.platform!==`linux`/);
  assert.match(patched, new RegExp(LINUX_CLIENT_SHA256));
  assert.match(patched, /y\.platform===`darwin`\|\|y\.platform===`linux`\|\|w/);
  assert.match(patched, /Control desktop apps on Linux through Computer Use/);
  assert.throws(() => enableLinuxComputerUse("missing"), /exactly one/);
});

test("the trusted Linux Computer Use hash matches the packaged plugin client", async () => {
  const client = await readFile(
    new URL("../desktop/linux-plugins/computer-use/scripts/computer-use-client.mjs", import.meta.url),
  );
  assert.equal(createHash("sha256").update(client).digest("hex"), LINUX_CLIENT_SHA256);
});
