# Port status

Verified on 2026-08-03 against ChatGPT `26.727.40816` (build `6067`), from the
Apple Silicon DMG whose SHA-256 is recorded in `upstream.json`.

## Architecture

The upstream application is an Electron renderer and main process connected to
the Codex app server. The Linux package keeps that JavaScript application and
replaces platform artifacts at its boundaries:

```text
upstream renderer and main process
              |
       Linux Electron 41
              |
 Linux Codex CLI / app-server
       |              |
 better-sqlite3     node-pty
```

The build extracts the checksum-verified DMG and ASAR, validates the expected
layout and extraction warnings, rebuilds native modules for Linux x86-64, adds
the Linux filesystem watcher, and stages one application tree. nFPM turns that
tree into Debian, RPM, and Arch packages. A deterministic root tarball feeds
the NixOS and Gentoo recipes. The pinned Debian 12 builder gives native modules
a glibc 2.36 baseline.

## Evidence

The automated suite has verified:

- sandboxed Electron startup and production renderer mounting;
- a Linux Codex app-server handshake and project opening;
- SQLite persistence across separate Electron processes;
- PTY output, exit status, and cancellation;
- filesystem watcher events;
- an authenticated renderer-to-app-server turn that created the requested file.

The live test is opt-in because it consumes account usage. It deletes the exact
test conversation through the app-server API, and cleanup failure fails the
test.

## Feature audit

Deep links have a packaged-Linux path in the upstream main process. Desktop
notifications and media APIs are supplied by Electron/Chromium. Projects,
threads, Git, terminals, plugins, skills, MCP, automations, SSH connections,
account flows, approvals, and shortcuts use the renderer or Codex app-server;
they do not contain a missing macOS binary boundary in this release. Not all of
these remote/UI workflows have dedicated end-to-end tests, so this is an
architecture finding rather than a claim that every screen is certified.

Sparkle is macOS-only and is disabled by the upstream platform check. Linux
updates are owned by APT/DNF and GitHub releases. Apple Events, Objective-C
bridges, Launch Services helpers, and macOS permission services are not portable
features; their relevant Linux equivalents are Electron, freedesktop desktop
entries, Chromium permission handling, and desktop portals.

## Remaining work

Computer use remains the substantial port. Its bundled subsystem depends on
separate macOS services and helpers. Browser control also requires a
`node_repl` executable. The DMG's bundled `node` and `node_repl` are arm64
Mach-O files; substituting ordinary Linux Node is insufficient because
`node_repl` is a separate sandboxed MCP server. No compatible artifact or
source is present in this release, so that backend cannot be ported here.

The compatibility runtime is stock Electron `41.10.3`, while the analyzed macOS
bundle uses customized Electron `42.3.0`. Host-specific behavior still merits
testing on real GNOME and KDE Wayland/X11 sessions, particularly audio,
notifications, keyring/portal prompts, suspend/resume, GPU behavior, browser
pairing, and SSH hosts. Those are release-coverage tasks unless testing exposes
a transformation or launcher defect.

The port is currently x86-64 only and supports one pinned upstream DMG. RPM
packaging shares the Debian-built glibc payload and therefore targets modern
glibc distributions; it still requires a clean Fedora-family installation test
before a public release should call it verified.
