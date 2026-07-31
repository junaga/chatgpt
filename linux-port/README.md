# Experimental Debian compatibility launcher

This directory is an analysis prototype, not an OpenAI-supported distribution.
It keeps application state below `linux-port/state` and points the desktop shell
at the locally installed Linux Codex CLI.

## Status

This is a functional Debian compatibility prototype, not a complete Linux port.
It is packaged, installed, and smoke-tested without disabling the Chromium
sandbox. Verified working:

- SQLite initialization and migrations
- Codex CLI discovery, process spawn, and initialize handshake
- Electron IPC router
- configuration, authentication-status, model, thread, permission-profile,
  plugin, and MCP-status requests
- authenticated ChatGPT account lookup and API access
- bundled production renderer and full desktop UI
- bundled plugin marketplace reconciliation
- browser-use native IPC initialization

Not verified end to end: agent turns and edits through the packaged UI, command
approvals, PTY interaction, voice/audio, notifications, global shortcuts, deep
links, automations, SSH/remote projects, browser extension pairing, first-time
login, logout, account expiry, and updates. Browser use initializes, but its
Node-REPL backend reports a missing runtime component.

Computer/desktop use is not ported. The included implementation depends on
macOS-native services. Apple Events, Objective-C bridges, macOS permission
helpers, and Sparkle updates are unavailable on Linux. Upstream Electron 41.10.3
is used instead of OpenAI's customized Electron 42 runtime, so subtle runtime
differences may remain.

The current evidence supports the core UI and app-server workflow only. It does
not support a claim that all features work.

## Run the current prototype

```bash
codex-desktop --open-project /path/to/project
```

It is also installed in the desktop application menu as **Codex Desktop**.

## Package

- Debian package: `../dist/codex-desktop-linux_26.727.40816-1_amd64.deb`
- Installed package: `codex-desktop-linux 26.727.40816-1`
- Install root: `/opt/codex-desktop-linux`
- Command: `/usr/bin/codex-desktop`
- SHA-256: `5a981bc77ff0907b19ee8721969e9eb9ced7e173629605d01763d5bf46df0b66`

Rebuild with:

```bash
sh /usr/local/codex-macos-analysis/linux-port/build-deb.sh
```

## Testing needed

This container can test installation, X11/Xvfb rendering, authentication reuse,
app-server startup, and API/listing operations. Broader coverage needs:

- a disposable Git repository for real turns, edits, approvals, cancellation,
  diffs, conflicts, and worktrees;
- GNOME and KDE sessions on both Wayland and X11;
- PipeWire virtual audio devices for voice and microphone tests;
- a notification daemon and D-Bus session;
- an SSH test VM and a Chrome/Chromium test profile;
- a suspend/resume-capable VM for scheduled automations;
- Mesa hardware acceleration plus software-rendering tests.

Some tests consume account usage or alter remote state. They should remain
explicit opt-in tests rather than run automatically.

## Known compatibility substitutions

- Upstream Electron 41.10.3 is used as a temporary bridge for the proprietary
  macOS `Codex Framework` runtime.
- `better-sqlite3` and `node-pty` were rebuilt as Linux x86-64 Electron addons.
- `CODEX_CLI_PATH` points to `/usr/local/bin/codex`.
- macOS-only Objective-C, Apple Events, permission, and updater helpers are not
  treated as available on Linux.
