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

Linux automation is supplied as two narrow MCP adapters:

```text
Browser MCP       -> Playwright -> dedicated Chromium profile
Computer Use MCP  -> OpenAI Sky Linux helper -> Xorg
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
- an authenticated renderer-to-app-server turn that created the requested file;
- browser discovery, MCP negotiation, and tool dispatch;
- Computer Use input validation, MCP negotiation, and the Wayland guard;
- package assembly of the Linux browser runtime and x86-64 Sky helper.

The browser and Computer Use checks are deliberately small unit and package
tests, not desktop integration tests. The existing live conversation test is
opt-in because it consumes account usage.

## Feature audit

Deep links have a packaged-Linux path in the upstream main process. Desktop
notifications and media APIs are supplied by Electron/Chromium. Projects,
threads, Git, terminals, plugins, skills, MCP, automations, SSH connections,
account flows, approvals, and shortcuts use the renderer or Codex app-server;
they do not contain a missing macOS binary boundary in this release. Not all of
these remote/UI workflows have dedicated end-to-end tests, so this is an
architecture finding rather than a claim that every screen is certified.

Sparkle is the macOS download/install updater. The Linux launcher forces its
shared upstream gate off, including the passive Linux relaunch watcher. Linux
updates are owned by the package manager and project releases. The setting is
not patched into the minified renderer: upstream's gray “Managed” row represents
organization policy, not platform capability.

Apple Events are not a general MCP feature. In this release they are a private
macOS transport between ChatGPT and its Computer Use service. The Linux Computer
Use adapter bypasses that transport. Other Objective-C, Launch Services, and
macOS permission hooks are platform plumbing; Linux deep links, notifications,
media permissions, and desktop integration use Electron and freedesktop APIs.

## Remaining work

Browser control is available through a Linux-owned Playwright MCP. `BROWSER` is
the first executable choice, followed by the XDG desktop default and known
Chromium commands. It always uses a dedicated profile. The exact upstream
in-app-browser and Chrome-extension backends remain unavailable because the DMG
contains only macOS builds of the sandboxed `node_repl` coordinator and native
extension host.

Computer Use is available on Xorg through the OpenAI `sky_linux_x64` helper
already present in the DMG. The adapter exposes only screenshot, click, drag,
move, key, scroll, and text actions. Native Wayland remains substantial work:
the intended design is XDG Remote Desktop and ScreenCast portals, PipeWire for
frames, and EIS/libei for compositor-mediated input. XWayland cannot provide
reliable full-desktop access to native Wayland applications, so the adapter
refuses Wayland by default.

Smaller gaps found in the deeper audit are system-wide dictation hotkey/paste,
secure enrollment of this machine as a remote-control client, and opening the
desktop's notification-settings panel. macOS Reminders and Messages are Apple
service integrations without direct Linux desktop equivalents. These are
documented exclusions, not evidence that normal voice chat, notifications, SSH,
or MCP are broken.

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
