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

test("NixOS and Gentoo recipes consume the current revision root tarball", async () => {
  const nix = await readFile(new URL("nix/default.nix", repositoryPackaging), "utf8");
  const gentoo = await readFile(new URL("gentoo/chatgpt-26.727.40816_p7.ebuild", repositoryPackaging), "utf8");
  for (const recipe of [nix, gentoo]) {
    assert.match(recipe, /upstream-26\.727\.40816-port\.7\/chatgpt\.tar\.gz/);
  }
  assert.doesNotMatch(nix, /AAAA/);
});

test("the Linux launcher disables in-app updates", async () => {
  const launcher = await readFile(new URL("../desktop/launcher.cjs", import.meta.url), "utf8");
  assert.match(launcher, /process\.env\.CODEX_SPARKLE_ENABLED = "false"/);
});

test("release artifacts use the short chatgpt basename", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("container/build.Dockerfile", import.meta.url), "utf8");
  const containerBuild = await readFile(new URL("../scripts/build-container.sh", import.meta.url), "utf8");
  assert.match(cli, /"chatgpt\.pkg\.tar\.zst"/);
  assert.match(cli, /`chatgpt\.\$\{format\}`/);
  assert.match(cli, /"chatgpt\.build\.json"/);
  assert.match(cli, /run\("convert"/);
  assert.match(cli, /"-resize", "512x512"/);
  assert.match(dockerfile, /imagemagick/);
  assert.match(dockerfile, /^COPY packaging \.\/packaging$/m);
  assert.match(dockerfile, /flatpak install .*--no-deps --no-related/);
  assert.match(dockerfile, /--no-static-deltas --or-update/);
  assert.match(dockerfile, /flatpak_attempt.*-ge 5/);
  assert.match(containerBuild, /mktemp -d/);
  assert.match(containerBuild, /--env TMPDIR=\/work\/tmp/);
  assert.match(containerBuild, /CODEX_DESKTOP_FORMATS/);
  assert.match(containerBuild, /src=\$build_work,dst=\/work/);
  assert.doesNotMatch(cli, /chatgpt-linux\.(?:deb|rpm|pkg\.tar\.zst|tar\.gz)/);
  assert.doesNotMatch(cli, /chatgpt-linux\.build\.json/);
});

test("the upstream Browser plugin is preserved and receives the exact node_repl runtime", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../desktop/launcher.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(cli, /installLinuxPlugin\(resources, installRoot, "browser"\)/);
  assert.match(cli, /extractNodeReplSources/);
  assert.match(cli, /patchChromeInstallManifestSource/);
  assert.match(launcher, /prepareChromeNativeHost/);
  assert.match(cli, /cp\(sourceModules/);
  assert.match(cli, /verbatimSymlinks: true/);
  assert.match(cli, /resources", "codex"/);
});

test("the bundled @oai/sky package is staged behind the Linux plugin", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const manifest = await readFile(new URL("../desktop/linux-plugins/computer-use/.codex-plugin/plugin.json", import.meta.url), "utf8");
  assert.match(cli, /installLinuxPlugin\(resources, installRoot, "computer-use"\)/);
  assert.match(cli, /@oai", "sky", "package\.json/);
  assert.match(cli, /linuxComputerUseDocumentation/);
  assert.match(cli, /cp\(source, destination, \{ recursive: true \}\)/);
  assert.match(cli, /rm\(path\.join\(destination, "\.mcp\.json"\)/);
  assert.match(cli, /"cua_node", "bin", "chatgpt-linux-computer-use"/);
  assert.match(cli, /"linux-runtime", "bin", "chatgpt-linux-computer-use"/);
  assert.equal(JSON.parse(manifest).name, "computer-use");
  assert.equal(JSON.parse(manifest).mcpServers, undefined);
});
