# ChatGPT/Codex macOS static analysis

Analysis date: 2026-07-31

## Acquisition

- Official download page: `https://chatgpt.com/download/`
- Direct artifact: `https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg`
- Local original: `original/ChatGPT.dmg`
- SHA-256: `fb93a239c811c7639cf45a90ff36c262fa0290640140cd12da3fdc60b62255ae`
- DMG volume name: `ChatGPT-26.727.40816-arm64`
- DMG filesystem creation time: `2026-07-30 16:54:18`

The original DMG has not been executed or modified. It was extracted with 7-Zip on Linux. Nine relative symlinks under bundled Node `node_modules/.bin` directories were skipped by 7-Zip's path-safety check.

## Verified application metadata

- Bundle identifier: `com.openai.codex`
- Display name: `ChatGPT`
- Alternate/signing base name: `Codex`
- Version: `26.727.40816` (build `6067`)
- Architecture: Apple Silicon (`arm64`)
- Application category: developer tools
- URL scheme: `codex://`
- ASAR SHA-256 declared by the bundle: `138f1b8b8ef83cafafd90b47998a5452f9a809d42a475b01ad476898a6586481`
- Update feed: `https://persistent.oaistatic.com/codex-app-prod/appcast.xml`

## Architecture: verified observations

1. **Desktop shell:** Electron `42.3.0`, Chromium `150.0.7871.182`, with a Vite-built main process and web renderer in `Resources/app.asar`.
2. **Renderer:** bundled JavaScript UI plus substantial WASM and document/spreadsheet/media assets. React `19.2.7` is present in the emitted bundle.
3. **Agent engine:** a bundled 270.6 MB native arm64 executable at `Contents/Resources/codex`. Its embedded Rust source-path strings identify crates including `app-server`, `app-server-client`, `codex-api`, transport, sandbox, MCP, skills, plugins, Git/filesystem, and execution components.
4. **Desktop-to-engine boundary:** the Electron main process starts Codex with `features.code_mode_host=true app-server --analytics-default-enabled`. Remote variants can use Unix sockets, WebSockets, SSH proxying, or remote-control transport. The bundle contains app-server request names such as `thread/start`, `turn/start`, and `config/batchWrite`.
5. **Persistence:** `better-sqlite3` is bundled for desktop state. The app-server state filename visible in the main bundle is `state_5.sqlite`; desktop settings use `$CODEX_HOME/config.toml` and `.codex-global-state.json`.
6. **Terminal/process integration:** `node-pty` is bundled, consistent with PTY-backed command execution. Native helpers include `codex-macos`, modifier/input monitors, HID topology, Launch Services integration, and device-key support.
7. **Computer/browser use:** a separate Node runtime and packages are bundled under `cua_node`, including Playwright, OCR (`tesseract.js`), image processing (`sharp`), canvas, and an OpenAI `sky` package. A separately signed-looking nested `Codex Computer Use.app` contains service, client, installer, and lock-screen guardian executables.
8. **Updates:** Sparkle is bundled and configured with an Ed25519 public key in `package.json`.
9. **Deep links:** parsed routes include settings, threads, new threads, automations, skills, plugins, pets, connectors/OAuth, browser use, SSH connections, and shared ChatGPT conversations. The parser validates host, paths, and allowed query parameters rather than treating arbitrary links as commands.
10. **Telemetry/network clues:** static bundles reference OpenAI/ChatGPT API, authentication, experimentation, telemetry, Sentry, and update hosts. Static strings establish possible code paths, not proof that every endpoint is contacted in a given session.

## High-level inferred data flow

```text
Electron renderer (web UI)
        |
        | restricted preload / Electron IPC
        v
Electron main process
        |
        | app-server request/event protocol
        v
Bundled native `codex` engine
        |-- filesystem, Git, PTY/process execution
        |-- sandbox and approval enforcement
        |-- MCP, skills, plugins, configuration
        `-- authenticated OpenAI/ChatGPT network APIs

Separate CUA subsystem
        `-- Playwright + native macOS computer-use services
```

The exact message schemas, trust checks, sandbox setup, credential storage, and network request flow require the next analysis pass. Dynamic behavior cannot be proven from this Linux host alone.

## Debian compatibility experiment

The extracted main process was launched on Debian using upstream Electron
41.10.3, Linux builds of `better-sqlite3` and `node-pty`, and the installed
`codex-cli 0.146.0` at `/usr/local/bin/codex`.

Verified runtime milestones:

- application readiness and local migrations complete;
- Linux Codex CLI spawned with app-server arguments;
- initialize handshake succeeds and reports version `0.146.0`;
- app-server state becomes connected;
- IPC router listens on `$CODEX_HOME/ipc/ipc.sock`;
- the production renderer mounts its application routes;
- an authenticated model turn submitted through the packaged renderer completes
  and creates the exact requested file in a disposable Git repository;
- the installed Linux `better-sqlite3` build writes and reopens a database in
  separate Electron processes;
- the installed Linux `node-pty` build streams child output, preserves a
  nonzero exit code, and terminates a running child;
- successful renderer requests include configuration, models, threads,
  permission profiles, plugins, MCP status, and collaboration modes;
- the client configuration explicitly advertises downloadable
  `linux-x86_64` primary-runtime bundles.

The prototype renders the authenticated production UI under Xvfb and is packaged
as `codex-desktop-linux_26.727.40816-1_amd64.deb`. The installed package runs
with Chromium's sandbox enabled, completes authenticated ChatGPT requests, loads
projects and recent threads, reconciles bundled plugins, and initializes
browser-use IPC.

The Debian package was also rebuilt end to end from the untouched, checksum-
verified DMG using the repository's TypeScript pipeline on 2026-08-02. The
pipeline extracts the ASAR, explicitly validates and repairs the nine safe
relative symlinks rejected by 7-Zip, rebuilds the declared Linux Electron native
artifacts from pinned npm packages, assembles the package, and emits a build
report. That freshly generated package was installed and passed all four
automatic port-boundary tests.

These results do not demonstrate feature completeness. The automated packaged-
UI turn test passed on 2026-08-02 but remains an explicit opt-in because it uses
account quota and creates a remote conversation. Voice, notifications,
shortcuts, deep links, automations, SSH, browser-extension pairing, account
lifecycle, and update behavior remain untested. The browser Node-REPL backend
reports a missing runtime component. Computer use, Apple Events, Objective-C
helpers, macOS permissions, and Sparkle cannot work as packaged because their
implementations are macOS-native. The upstream Electron 41 compatibility
runtime may also differ from OpenAI's customized Electron 42 runtime.

A credible release test requires disposable-repository scenarios; real GNOME
and KDE Wayland/X11 sessions; PipeWire audio; D-Bus notifications; an SSH test
host; a browser test profile; suspend/resume testing; and hardware/software GPU
coverage. Tests that consume model usage or change remote account state should
be opt-in.
