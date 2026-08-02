# chatgpt-linux

An experimental Debian compatibility port and static-analysis record for the
ChatGPT Codex macOS desktop app. This is an independent research project, not an
OpenAI product or supported Linux release.

The port currently launches the upstream production renderer with stock Linux
Electron, rebuilt Linux native modules, and the installed Linux Codex CLI. It
has rendered the authenticated UI and connected to Codex app-server. That is
useful progress, but it is **not a complete port** and does not establish that
all product features work.

See [REPORT.md](REPORT.md) for observed architecture and evidence, and
[linux-port/README.md](linux-port/README.md) for the exact compatibility
substitutions, limitations, packaging instructions, and focused smoke test.

## Repository contents

- `port/`: typed DMG validation, extraction, native rebuild, and Debian
  packaging pipeline
- `linux-port/`: launcher, Debian packaging metadata, and port-boundary test
- `REPORT.md`: static and dynamic findings, with verified facts separated from
  limitations and untested behavior

The downloaded DMG, extracted proprietary application, generated package,
runtime state, and `node_modules` are deliberately excluded from Git. A local
checkout therefore does not contain enough material to build the package until
the upstream app has been acquired for legitimate local analysis.

## Build from the DMG

The supported DMG can be converted end to end without committing or modifying
the proprietary input:

```bash
npm ci
npm run port -- build --dmg ~/Downloads/ChatGPT.dmg
```

The TypeScript pipeline verifies the complete DMG checksum, installs pinned
Linux build dependencies, extracts the application and ASAR, validates upstream
metadata and layout, repairs only version-declared safe symlinks, rebuilds the
declared Electron native modules, and creates the Debian package under `dist/`.
It also writes a neighboring `.build.json` report containing input/output hashes
and build metadata.

Build requirements are Node.js, npm, 7-Zip, `dpkg-deb`, and the normal native
compiler toolchain required by `node-gyp`. Use `inspect` to validate a DMG
without extracting or building it:

```bash
npm run port -- inspect --dmg ~/Downloads/ChatGPT.dmg
```

Unknown checksums fail closed. Supporting a new upstream build requires a new
reviewed manifest under `port/manifests/` and any necessary compatibility work.
Generated work directories, DMGs, extracted files, packages, and build reports
remain excluded from Git.

## Upstream version tags

Compatibility work is versioned against the upstream DMG rather than assumed to
work unchanged with every ChatGPT release. Tags use
`upstream-<dmg-version>`, for example `upstream-26.727.40816`.

Each tag identifies the launcher, packaging logic, tests, and findings verified
for that DMG version. The matching DMG checksum remains authoritative because
the download URL itself may be reused for a newer build. A tag does not include
or redistribute the DMG, extracted application, or generated Debian package.

When porting another upstream release, create a commit containing its verified
metadata and compatibility changes, run the port tests, and tag that commit with
its exact DMG version. Port-specific packaging revisions can remain in the
Debian revision suffix without pretending they are new upstream versions.

## What is tested

`npm test` under `linux-port/` starts the installed Debian application with a
temporary profile and Git repository, connects through Electron's debugging
protocol, checks that the production renderer mounts, and verifies the Chromium
sandbox installation. It also loads the installed Electron-ABI builds of
`better-sqlite3` and `node-pty`, checking database persistence across processes
and PTY output, exit status, and cancellation. It does not sign in or submit
prompts.

An explicit `npm run test:live` test can submit one authenticated turn against a
disposable repository and verify its exact file edit. It consumes account usage
and creates a remote thread, so it is intentionally excluded from `npm test`.
The test passed against the installed package on 2026-08-02.

## Known gaps

macOS-native computer-use services, Apple Events, Objective-C bridges,
permission helpers, and Sparkle updates are not ported. Approval UI, voice/audio,
notifications, deep links, automations, SSH projects, browser pairing, account
lifecycle, and update behavior still need explicit end-to-end coverage. Some of
those tests require account usage, real desktop services, or external
infrastructure and should remain opt-in.
