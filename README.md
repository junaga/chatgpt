# chatgpt-linux

An experimental Debian compatibility port of the ChatGPT Codex macOS desktop
app. This is an independent research project, not an OpenAI product or supported
Linux release.

The current checkout supports exactly one upstream DMG. [`upstream.json`](upstream.json)
contains only values the build cannot derive: its checksum, port revision,
extraction path, native artifact destinations, and accepted extraction warnings.
The upstream version and build come from the checksum-verified app; the Linux
Electron version comes from the pinned desktop workspace. Git history—not a
runtime strategy registry—preserves support for older releases.

The current port launches the upstream production renderer with stock Linux
Electron, rebuilt Linux native modules, and the installed Linux Codex CLI. The
authenticated renderer-to-app-server file-edit workflow has passed end to end.
This is still not a complete Linux port; see [REPORT.md](REPORT.md) for verified
findings and remaining gaps.

## Build the supported release

Requirements:

- Linux x86-64
- Node.js and npm
- 7-Zip and `dpkg-deb`
- the native compiler toolchain required by `node-gyp`
- a locally obtained copy of the exact supported ChatGPT DMG

```bash
npm ci
npm run port -- inspect --dmg ~/Downloads/ChatGPT.dmg
npm run port -- build --dmg ~/Downloads/ChatGPT.dmg
```

`inspect` hashes the DMG and fails unless it matches `upstream.json`. `build`
installs pinned desktop dependencies, extracts the DMG and ASAR, validates the
upstream layout, accepts only the declared extraction warnings, rebuilds the
declared Electron native modules, and writes the Debian package under `dist/`.

A neighboring `.deb.build.json` records the input and output hashes. Package
bytes are not claimed to be reproducible across machines because archive
timestamps and external tool versions are not normalized.

Native modules inherit the C library baseline of the build host. For a package
that runs on Debian 12 or newer, build in the pinned Bookworm container:

```bash
npm run port:container
```

This reads `original/ChatGPT.dmg` and writes to `dist/` by default. Override
those paths with `CODEX_DESKTOP_DMG` and `CODEX_DESKTOP_OUTPUT`.

The DMG, extracted application, generated package, build workspace, runtime
state, and `node_modules` are deliberately excluded from Git.

## Versioning model

`main` targets the newest upstream release we are actively porting. Each
verified snapshot receives an immutable tag:

```text
upstream-<dmg-version>-port.<revision>
```

For example:

```text
upstream-26.727.40816-port.1
upstream-26.727.40816-port.2
upstream-26.727.40816-port.3
```

A port bug fix for an older DMG is made from its tag on a temporary maintenance
branch and receives a new port-revision tag. Published tags are never moved.
Checking out a tag restores the complete matching builder, launcher,
dependencies, tests, documentation, and `upstream.json`.

Supporting a new DMG means changing the current code and metadata together. A
similar release may need only metadata and dependency updates; an architectural
change can legitimately require rewriting the extractor or launcher. We do not
claim that arbitrary future DMGs can be ported by configuration alone.

## Repository layout

```text
desktop/       packaged launcher, Debian metadata, dependencies, and app tests
src/           TypeScript DMG-to-DEB builder
test/          builder metadata tests
upstream.json  the one upstream release supported by this checkout
REPORT.md      static analysis, runtime evidence, and known limitations
```

## Tests

Builder metadata and type checking:

```bash
npm test
```

After installing the generated Debian package, test the compatibility seams:

```bash
npm run test:installed
```

The same tests can target an unpacked package tree without installation. The
unpacked run uses Chromium's user-namespace sandbox because its sandbox helper
cannot be root-owned before installation:

```bash
dpkg-deb -x dist/codex-desktop-linux_*.deb /tmp/chatgpt-linux-package
CODEX_DESKTOP_PACKAGE_ROOT=/tmp/chatgpt-linux-package/opt/codex-desktop-linux \
  npm run test:installed
```

That suite verifies the sandboxed packaged renderer, SQLite persistence across
Electron processes, filesystem watching, and PTY output, exit status, and cancellation. The
authenticated file-edit test is opt-in because it consumes account usage and
creates a remote conversation:

```bash
npm run test:live
```

### Containerized runtime test

The generated package can be tested in a clean Debian userspace with Xvfb. This
is a reproducible check of package dependencies, Electron startup, the renderer,
SQLite, PTY handling, and the Linux Codex app-server boundary:

```bash
npm run test:container
```

If `dist/` contains more than one package, select one explicitly:

```bash
CODEX_DESKTOP_DEB="$PWD/dist/codex-desktop-linux_26.727.40816-3_amd64.deb" \
  npm run test:container
```

The account-backed test is also available in the container:

```bash
npm run test:container:live
```

Live mode mounts `$HOME/.codex` read-only, copies it into the disposable
container, submits one real model turn, then permanently deletes
the test thread through Codex's app-server API. Usage cannot be recovered. Cleanup failure
fails the test instead of being hidden. Set `CODEX_LIVE_KEEP_THREAD=1` to retain
the thread deliberately, or `CODEX_LIVE_CODEX_HOME` to use another authenticated
profile. The image pins the Codex CLI version verified by this checkout.

A container does **not** validate integration with the host desktop. Deep-link
registration, D-Bus notifications, PipeWire audio, browser pairing, keyring
behavior, Wayland/X11 differences, GPU behavior, and suspend/resume still need
host-level tests. Playwright remains the UI driver; filesystem, process, SQLite,
and PTY assertions provide external evidence for the boundaries tested here.

## Known gaps

macOS-native computer-use services, Apple Events, Objective-C bridges,
permission helpers, and Sparkle updates are not ported. Approval UI, voice and
audio, notifications, deep links, automations, SSH projects, browser pairing,
account lifecycle, and update behavior still need explicit end-to-end coverage.
