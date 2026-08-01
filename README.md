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

- `linux-port/`: launcher, Debian packaging metadata, and port-boundary test
- `REPORT.md`: static and dynamic findings, with verified facts separated from
  limitations and untested behavior

The downloaded DMG, extracted proprietary application, generated package,
runtime state, and `node_modules` are deliberately excluded from Git. A local
checkout therefore does not contain enough material to build the package until
the upstream app has been acquired and extracted for legitimate local analysis.

## What is tested

`npm test` under `linux-port/` starts the installed Debian application with a
temporary profile and Git repository, connects through Electron's debugging
protocol, checks that the production renderer mounts, and verifies the Chromium
sandbox installation. It does not sign in, submit prompts, execute commands, or
claim coverage of unchanged upstream features.

## Known gaps

macOS-native computer-use services, Apple Events, Objective-C bridges,
permission helpers, and Sparkle updates are not ported. Agent turns and edits,
approvals, PTY behavior, voice/audio, notifications, deep links, automations,
SSH projects, browser pairing, account lifecycle, and update behavior still
need explicit end-to-end coverage. Some of those tests require account usage,
real desktop services, or external infrastructure and should remain opt-in.
