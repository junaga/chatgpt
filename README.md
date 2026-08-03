# ChatGPT for Linux

An experimental Linux compatibility build of the ChatGPT Codex desktop app.
It runs the checksum-verified upstream renderer with Linux Electron, native
modules, and the Codex CLI. This is an independent project, not an OpenAI
product or supported Linux release.

## Install

Debian, Ubuntu, and derivatives:

```bash
curl -fL https://github.com/junaga/chatgpt-linux/releases/latest/download/chatgpt-linux.deb -o /tmp/chatgpt.deb && sudo apt install /tmp/chatgpt.deb
```

Fedora, RHEL, openSUSE, and derivatives:

```bash
sudo dnf install https://github.com/junaga/chatgpt-linux/releases/latest/download/chatgpt-linux.rpm
```

Arch Linux and derivatives:

```bash
curl -fLO https://github.com/junaga/chatgpt-linux/releases/latest/download/chatgpt-linux.pkg.tar.zst && sudo pacman -U chatgpt-linux.pkg.tar.zst
```

NixOS and Gentoo package definitions are in `packaging/nix` and
`packaging/gentoo`. They intentionally remain native recipes rather than opaque
installer scripts.

The Codex CLI must also be installed and authenticated. Start the app with
`chatgpt` or from the desktop menu.

```text
$ apt show chatgpt
Package: chatgpt
Version: 26.727.40816-4
Priority: optional
Section: devel
Maintainer: ChatGPT Linux contributors <noreply@github.com>
Architecture: amd64
Recommends: codex
Description: Experimental ChatGPT Codex desktop compatibility port for Linux.
 Runs the upstream desktop renderer with Linux Electron, native modules,
 and the Codex CLI. This is an independent project, not an OpenAI product.
Homepage: https://github.com/junaga/chatgpt-linux
```

## What works

The production UI, authenticated model turns, projects, threads, file edits,
Git, terminals, plugins, skills, MCP, automations, SSH connections, desktop
notifications, and `codex://` links use Linux-compatible Electron or Codex
interfaces.

Computer use is not ported. Browser control's Node-REPL backend is also
unavailable: the DMG contains only arm64 Mach-O `node` and `node_repl`
executables, and no supported Linux `node_repl` artifact is present in this
release. Apple Events, Objective-C helpers,
macOS permission services, and Sparkle have no role on Linux; desktop portals,
Chromium permissions, and the system package manager provide the corresponding
Linux boundaries. See [REPORT.md](REPORT.md) for the evidence and limitations.

## Build

The checkout supports the exact DMG identified by `upstream.json`. On Linux
x86-64 with Node.js, npm, 7-Zip, a C++ toolchain, and nFPM:

```bash
npm ci
npm run port -- build --dmg ~/Downloads/ChatGPT.dmg
```

This creates DEB, RPM, Arch, and deterministic tarball artifacts under `dist/`,
plus a build report. For a Debian 12 native-library baseline, use the pinned
container:

```bash
npm run port:container
```

Select a comma-separated subset of `deb,rpm,archlinux,tar.gz` with `--formats`.
All artifacts come from the same staged application tree. The NixOS expression
is under `packaging/nix`; the Gentoo ebuild is under `packaging/gentoo`. Both
consume the deterministic tarball. Alpine is excluded because this build
contains glibc native modules. AppImage, Flatpak, and Snap would add parallel
distribution and update systems without improving native package-manager
coverage.

## Test

```bash
npm test
npm run test:container
```

The container suite covers compatibility code owned by this repository, not
Electron or desktop-system behavior. The authenticated test consumes account
usage and deletes its disposable thread during teardown:

```bash
npm run test:container:live
```

`main` tracks the current upstream DMG. Verified snapshots use immutable tags
named `upstream-<version>-port.<revision>`.
