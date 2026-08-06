# Minimal-port comparison and downstream audit

Last updated: 2026-08-01

This is a living evidence log comparing this wrapper repository with an
external minimal Debian compatibility prototype built from the same official
OpenAI application. Update it as more behavior is reproduced or disproved.

## Scope and evidence rules

- **Verified** means observed in source, measured locally, or reproduced by a
  controlled command.
- **Reported downstream defect** means the linked issue identifies wrapper code
  or a wrapper-owned feature as the cause.
- **Inference** means the available evidence supports the conclusion but does
  not constitute an end-to-end behavioral test.
- A wrapper issue is not assumed to be wrapper-caused. For example, the
  multi-window dynamic-tool fan-out in issue #1126 was compared with the raw
  ASAR and found to be inherited from OpenAI's app.

This audit does not claim that the minimal prototype has feature parity. Its
verified and unverified boundaries were recorded in the external prototype's
`REPORT.md` and `linux-port/README.md`.

## Compared artifacts

### Official application used by the minimal prototype

- App version: `26.727.40816`, build `6067`
- DMG SHA-256:
  `fb93a239c811c7639cf45a90ff36c262fa0290640140cd12da3fdc60b62255ae`
- Official Electron version: `42.3.0`
- Extracted ASAR: `extracted/app-asar`
- Prototype runtime: upstream Electron `41.10.3`
- Prototype Codex CLI: `0.146.0`

### Unofficial wrapper

- Local checkout: `/usr/local/dev/codex-desktop-linux`
- Patch experiment commit:
  `5b30c7716a8abea0cd0685370ae9772e27e30b59`
- Current inspected `origin/main`:
  `cef67b8c06fb411af3c685cb76022536dc88b3f8`
- Current tracked files: 549
- Current tracked lines: 209,523
- Current commits: 1,809
- Initial commit: 425 repository lines, including a 288-line installer

The patch experiment deliberately used wrapper commit `5b30c77` because that
commit and this prototype targeted the same official app version. The five
wrapper commits inspected afterward changed AppImage/warm-start handling, Nix
pins, and an optional Dock-icon feature; the core descriptor inventory remained
82.

## Executive finding

The minimal prototype ports the official application's host environment. It
reuses the official Electron application without rewriting its JavaScript
product behavior, substitutes a Linux Electron runtime and Linux native addons,
points the application at the Linux Codex CLI, and packages the result.

The unofficial wrapper still depends on the official ASAR, so it is not a
from-scratch reimplementation. It has, however, evolved from a thin port into a
downstream binary fork and compatibility distribution. It rewrites minified
main-process and renderer bundles, replaces or extends multiple application
subsystems, supplies Linux-native feature backends, and adds a separate updater,
launcher, renderer server, packaging matrix, and feature framework.

## Size comparison

Before its comparison audit document was added, the external minimal prototype
contained 341 authored lines when its two original reports were included. Its
actual implementation/configuration portion remains approximately 149 lines;
its launcher and package build scripts contain 92 executable lines.

The wrapper currently contains 209,523 tracked lines. Major measured categories
at the earlier audit point included:

- 68,382 lines in explicitly named test files;
- 57,441 lines under `linux-features/`, including 33,223 explicit test lines;
- 53,775 lines under `scripts/`, including 18,974 explicit test lines;
- 24,688 lines under `updater/`;
- 21,050 lines under `computer-use-linux/`;
- 13,643 lines under `record-replay-linux/`;
- 9,637 lines of root/documentation Markdown;
- 4,574 lines in the current launcher template alone.

The wrapper began at essentially the same scale as this prototype. Its root
commit was a 288-line automated installer that downloaded the DMG, extracted
the ASAR, rebuilt `better-sqlite3` and `node-pty`, downloaded Linux Electron,
copied the renderer, and launched it.

## Evidence that the official payload is already cross-platform

The official package is macOS-distributed but not purely macOS-designed.
Verified contents include:

- Electron Forge dependencies for Debian, RPM, MSIX, and ZIP packaging in the
  external prototype's extracted official `app-asar/package.json`;
- 29 direct equality/inequality checks for `process.platform` and `linux` in
  the emitted Electron main-process bundles;
- extensive Windows-specific branches alongside the Linux branches;
- a privileged, secure, fetch-capable `app://` protocol registration;
- a packaged-webview handler that maps `app://-/index.html` and `app://fs`
  requests to files under the bundled `webview` directory;
- Linux-specific file-response behavior inside that protocol handler;
- Linux runtime bundle metadata exposed through the working application.

The minimal launcher does not set `ELECTRON_RENDERER_URL`. The successful
renderer mount therefore exercises the official application's packaged
renderer path instead of an external development server.

## Controlled ASAR patch experiment

The wrapper's core patcher was run against a temporary copy of this prototype's
official `26.727.40816` extracted ASAR. All optional Linux features were
disabled. Critical-patch enforcement was enabled. Pre- and post-run SHA-256
inventories were compared, and the temporary copy was deleted afterward.

Result:

- 82 core patch descriptors were discovered;
- 61 reported `applied`;
- 17 reported `already-applied` or equivalent upstream behavior;
- 5 opt-in descriptors were disabled;
- 17 files were changed or created;
- the main bundle grew by 51,888 bytes;
- `app-initial` grew by 9,324 bytes;
- six new `linux-*.js` settings assets were added.

Current descriptor policy distribution:

| Policy | Count |
|---|---:|
| `required-upstream` | 16 |
| `optional` | 61 |
| `opt-in` | 5 |

Current phase distribution:

| Phase | Count |
|---|---:|
| Main bundle | 42 |
| Webview asset | 26 |
| Extracted app before webview | 9 |
| Extracted app after webview | 5 |

The minimal prototype had already completed application readiness, app-server
initialization, authenticated API calls, project/thread loading, plugin
reconciliation, and renderer mounting without these transformations. That does
not prove every transformation is unnecessary for every feature, but it proves
they are not collectively required for core startup and authenticated UI use.

## Confirmed architectural differences

### 1. Packaged renderer versus loopback HTTP server

The minimal prototype leaves the official `app://` renderer mechanism active.
It has no renderer port, Python server, renderer PID file, server adoption, or
server lifetime problem.

The wrapper unconditionally derives a renderer origin from
`http://127.0.0.1:$CODEX_LINUX_WEBVIEW_PORT`, normally port 5175. It launches a
bundled Python HTTP server and exports that URL through
`ELECTRON_RENDERER_URL`:

- [current launcher origin and server](https://github.com/ilysenko/codex-desktop-linux/blob/cef67b8c06fb411af3c685cb76022536dc88b3f8/launcher/start.sh.template#L263)
- [wrapper's server evaluation](https://github.com/ilysenko/codex-desktop-linux/blob/cef67b8c06fb411af3c685cb76022536dc88b3f8/docs/webview-server-evaluation.md)

The server is inherited from the wrapper's original installer. Current wrapper
documentation describes removing it as the highest-risk option and potentially
requiring app-bundle changes. The current official payload and the working
minimal prototype contradict that assumption: the app already contains and
uses a packaged renderer protocol when the override is absent.

This server choice created a second process-lifecycle system, fixed ports,
health probes, ownership checks, PID state, warm-start adoption, and stale
process recovery.

### 2. Chromium sandbox

The minimal Debian package installs Electron's `chrome-sandbox` as root with
mode `4755` and does not pass sandbox-disabling flags. Runtime testing confirmed
that Chromium's sandbox remains enabled. The relevant external prototype files
were `linux-port/build-deb.sh` and `linux-port/packaging/codex-desktop`.

The wrapper currently passes both `--no-sandbox` and
`--disable-gpu-sandbox` unconditionally:

- [current launch arguments](https://github.com/ilysenko/codex-desktop-linux/blob/cef67b8c06fb411af3c685cb76022536dc88b3f8/launcher/start.sh.template#L3978)

This is a verified security regression relative to the minimal package.

### 3. Product-semantic patches

The wrapper's default core patch inventory is not limited to OS adaptation. It
also changes product behavior, including:

- automation RRULE parsing and multiple-time scheduling;
- persistent composer rate-limit rendering;
- subagent metadata compatibility and nickname lookup;
- settings-search filtering;
- chat-search hydration;
- local-environment modal draft behavior;
- eager loading of the `automation_update` dynamic tool;
- skills-list deduplication;
- configuration write conflict semantics.

Examples:

- [automation schedule replacement](https://github.com/ilysenko/codex-desktop-linux/blob/cef67b8c06fb411af3c685cb76022536dc88b3f8/scripts/patches/impl/automation-schedule.js)
- [renderer patch implementations](https://github.com/ilysenko/codex-desktop-linux/blob/cef67b8c06fb411af3c685cb76022536dc88b3f8/scripts/patches/impl/webview/index.js)

These are downstream application modifications, not merely Linux runtime
substitutions.

### 4. Configuration concurrency weakening

The `linux-config-write-version-conflict` patch replaces matched
`expectedVersion` expressions with `expectedVersion:null` across a set of
configuration-writing renderer bundles:

- [implementation](https://github.com/ilysenko/codex-desktop-linux/blob/cef67b8c06fb411af3c685cb76022536dc88b3f8/scripts/patches/impl/webview/index.js#L1541)

Verified effect: upstream optimistic version checks are bypassed for those
writes. The motivating commit says this avoids stale versions after the local
configuration version changes during startup. The tradeoff is that genuine
concurrent configuration changes can no longer be rejected through that
mechanism. Data loss has not been reproduced, so that consequence remains a
risk inference rather than a confirmed defect.

### 5. Patch-criticality inflation

Sixteen descriptors are marked `required-upstream`. They include lifecycle and
window work, but also `subagent-nickname-metadata-shape` and package desktop
metadata.

Issue [#1155](https://github.com/ilysenko/codex-desktop-linux/issues/1155)
records a current-DMG update rejected because four required patch needles no
longer matched. With critical enforcement disabled, the reporter confirmed that
the candidate built, launched, and served the renderer successfully. This is
direct evidence that at least that required-patch gate was stronger than the
observed launch requirement.

## Confirmed downstream regressions from issue evidence

| Evidence | Attribution | Finding |
|---|---|---|
| [#963](https://github.com/ilysenko/codex-desktop-linux/issues/963) | Wrapper renderer-server/launcher architecture | Killing the launcher killed its webview server while Electron survived; warm start then handed off to an app whose renderer origin was dead. |
| [#939](https://github.com/ilysenko/codex-desktop-linux/issues/939) | Injected wrapper quit patches | A cancellable/re-entrant `before-quit` path destroyed the tray and application context while leaving the process alive, making it unopenable and unclosable. |
| [#1054](https://github.com/ilysenko/codex-desktop-linux/issues/1054) | Wrapper tray rewrite | A refactor explicitly discarded `iconPathExpression`, removing the Linux tray icon patch. |
| [#1132](https://github.com/ilysenko/codex-desktop-linux/issues/1132) | Wrapper launcher environment | Redirecting global `TMPDIR` into `$XDG_RUNTIME_DIR` put large stale Git snapshots in tmpfs; 2.8 GiB of residue contributed to memory pressure and OOM. |
| [#1155](https://github.com/ilysenko/codex-desktop-linux/issues/1155) | Wrapper patch/update gate | Minified-symbol drift blocked an update even though bypassing the gate produced a candidate that launched. |
| [#1163](https://github.com/ilysenko/codex-desktop-linux/issues/1163) | Optional wrapper feature | `directory-only-working-tree-watch` was the main A/B-correlated cause of sustained single-core CPU use and slower conversation resume. |
| [#1175](https://github.com/ilysenko/codex-desktop-linux/issues/1175) | Wrapper Sparkle replacement | The replacement omitted `getDownloadProgressPercent`, causing repeated AppView RPC registration failures. |
| [#1171](https://github.com/ilysenko/codex-desktop-linux/issues/1171) and [fix #1196](https://github.com/ilysenko/codex-desktop-linux/pull/1196) | Wrapper AppImage/warm-start handling | Reopening a hidden AppImage through a changed mount path could conflict with or damage the live instance state; the current wrapper HEAD is a further fix for it. |

### Important counterexample

Issue [#1126](https://github.com/ilysenko/codex-desktop-linux/issues/1126)
reports dynamic tool calls being executed once per open primary window. The
maintainer compared the relevant path with a raw, unpatched ASAR and found the
broadcast behavior unchanged. This issue is therefore currently attributed to
the official application, not the Linux wrapper. It must not be used as evidence
against the wrapper.

## What the wrapper does better today

The wrapper contains substantial functionality absent from the minimal
prototype:

- one-command DMG acquisition, extraction, addon rebuild, and packaging;
- matching the official Electron 42 version rather than using Electron 41;
- Debian, RPM, pacman, AppImage, Nix, and multiple architecture support;
- current-release tracking, candidate building, rollback, and update state;
- Linux tray, notification, browser, voice, Computer Use, and desktop-specific
  work;
- extensive automated patch and packaging tests.

Its focused Node patch suite passed 405 tests at current HEAD during this audit.
The problem is not an absence of effort or tests. The problem is that its scope
and architecture require tests for a very large downstream mutation surface.

## Current conclusion

The wrapper remains dependent on OpenAI's application and is not a distinct
from-scratch client. The most accurate classification is:

> A continuously rebased binary fork and Linux compatibility distribution built
> around the official application.

The minimal prototype is currently closer to a traditional port:

> Preserve the application; replace the host runtime and platform-native
> dependencies.

A maintainable minimal Linux release should automate the existing build,
upgrade to the exact official Electron version, and add tests before expanding
scope. Minified-ASAR modifications should require a reproduced Linux-only
failure and an A/B demonstration that the unmodified official path fails.

Recommended invariants:

1. Keep OpenAI's ASAR byte-identical unless a specific defect is proven.
2. Use the official packaged `app://` renderer path.
3. Keep Chromium's sandbox enabled.
4. Do not modify unrelated product semantics as “Linux compatibility.”
5. Keep platform replacements outside the ASAR where possible.
6. Pin and record the official DMG, Electron, CLI, and native-addon versions.
7. Test real turns, approvals, PTY, lifecycle, desktop sessions, and updates
   before claiming feature completeness.

## Investigation log

### 2026-08-01

- Measured repository size and history.
- Verified that the wrapper began as a thin 288-line installer.
- Identified 82 current core patch descriptors.
- Applied the wrapper patcher to the same official ASAR used by this prototype
  and measured 61 applied transformations across 17 files.
- Verified the official application's packaged `app://` renderer handler and
  existing Linux branches.
- Verified that the minimal package keeps Chromium sandboxing enabled while the
  wrapper disables both Chromium and GPU sandboxes.
- Reviewed current wrapper source, documentation, and selected GitHub issue
  evidence with `gh`; no connector/MCP access was used.
- Fast-forwarded the local wrapper clone to `cef67b8` and confirmed that the
  core descriptor inventory remains 82.
