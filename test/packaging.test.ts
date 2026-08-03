import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packaging = new URL("../desktop/packaging/", import.meta.url);

test("shared package metadata names the app and both native package families", async () => {
  const manifest = await readFile(new URL("nfpm.yaml", packaging), "utf8");
  assert.match(manifest, /^name: chatgpt$/m);
  assert.match(manifest, /^  deb:$/m);
  assert.match(manifest, /^  rpm:$/m);
  assert.match(manifest, /type: tree/);
});

test("Linux desktop integration registers the chatgpt command and codex links", async () => {
  const entry = await readFile(new URL("chatgpt.desktop", packaging), "utf8");
  const launcher = await readFile(new URL("chatgpt", packaging), "utf8");
  assert.match(entry, /^Exec=\/usr\/bin\/chatgpt %U$/m);
  assert.match(entry, /^MimeType=x-scheme-handler\/codex;$/m);
  assert.match(launcher, /exec \/opt\/chatgpt\/codex-desktop/);
});
