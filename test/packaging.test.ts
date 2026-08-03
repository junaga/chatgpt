import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packaging = new URL("../desktop/packaging/", import.meta.url);
const repositoryPackaging = new URL("../packaging/", import.meta.url);

test("shared package metadata names the app and native package families", async () => {
  const manifest = await readFile(new URL("nfpm.yaml", packaging), "utf8");
  assert.match(manifest, /^name: chatgpt$/m);
  assert.match(manifest, /^  deb:$/m);
  assert.match(manifest, /^  rpm:$/m);
  assert.match(manifest, /^  archlinux:$/m);
  assert.match(manifest, /type: tree/);
});

test("the desktop entry declares the chatgpt command and codex links", async () => {
  const entry = await readFile(new URL("chatgpt.desktop", packaging), "utf8");
  const launcher = await readFile(new URL("chatgpt", packaging), "utf8");
  assert.match(entry, /^Exec=\/usr\/bin\/chatgpt %U$/m);
  assert.match(entry, /^MimeType=x-scheme-handler\/codex;$/m);
  assert.match(launcher, /exec \/opt\/chatgpt\/codex-desktop/);
});

test("NixOS and Gentoo recipes consume the revision-four root tarball", async () => {
  const nix = await readFile(new URL("nix/default.nix", repositoryPackaging), "utf8");
  const gentoo = await readFile(new URL("gentoo/chatgpt-26.727.40816_p4.ebuild", repositoryPackaging), "utf8");
  for (const recipe of [nix, gentoo]) {
    assert.match(recipe, /upstream-26\.727\.40816-port\.4\/chatgpt\.tar\.gz/);
  }
  assert.doesNotMatch(nix, /AAAA/);
});

test("release artifacts use the short chatgpt basename", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /"chatgpt\.pkg\.tar\.zst"/);
  assert.match(cli, /`chatgpt\.\$\{format\}`/);
  assert.match(cli, /"chatgpt\.build\.json"/);
  assert.doesNotMatch(cli, /chatgpt-linux\.(?:deb|rpm|pkg\.tar\.zst|tar\.gz)/);
  assert.doesNotMatch(cli, /chatgpt-linux\.build\.json/);
});
