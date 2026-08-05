# Port report

This checkout ports ChatGPT `26.730.61639` (build `6234`) from the exact upstream
archive recorded in `upstream.json`. It is an independent project, not an OpenAI
release.

## What is ported

The upstream renderer, main process, plugins, and Codex app-server protocol are
kept. The build replaces only their macOS boundaries:

- Electron, `better-sqlite3`, `node-pty`, and filesystem watching are native
  Linux x86-64 builds.
- The pinned Codex CLI is included, so a separate CLI installation is not
  required.
- Deep links, media, terminals, projects, Git, SSH, skills, MCP, approvals,
  automations, and account flows use their normal Electron or Codex paths.
- Notifications use Electron plus freedesktop desktop identity, permission
  status, and GNOME/KDE/Xfce/Cinnamon settings links.
- Remote-control enrollment uses P-256 device keys protected by Electron's
  Linux Secret Service/KWallet storage.
- Dictation supports X11 input and the Wayland Global Shortcuts and Remote
  Desktop portals. The system-wide shortcut depends on compositor support.
- The complete 19-method Picture-in-Picture contract is implemented with an
  always-on-top Electron surface for Browser Use and Computer Use previews.
- Wayland sessions explicitly select Electron's native Wayland backend instead
  of relying on Chromium's automatic X11/Wayland choice.

## Browser Use

Browser Use follows the upstream architecture; it does not use Playwright or
the `BROWSER` environment variable. The upstream Browser plugin, browser
client, browser discovery, policies, confirmations, and exact three-tool
`node_repl` interface are retained.

Linux supplies the missing coordinator and Chrome/Edge native-messaging host.
They support the production extension protocol, side-panel app-server runtime,
authenticated ChatGPT requests, configuration access, Codex sandboxing, file
assets, and the same browser socket transport. Flatpak installs a private
host-visible launcher so a normal host Chrome process can enter the Flatpak
runtime safely.

Analytics-only extension routes are not proxied. They do not control Browser
Use or model capability.

## Computer Use

Computer Use exposes the same `sky` window API and method names as macOS. The
packaged plugin retains the upstream workflow and confirmation policy.

- AT-SPI supplies app discovery, app launch/activation, accessibility trees,
  stable element indexes, diffs, semantic clicks, values, selections, and
  secondary actions on X11 and Wayland.
- X11 screenshots and raw pointer/keyboard input use the upstream bundled
  Linux Sky client.
- Wayland screenshots use the XDG Screenshot portal. Pointer, keyboard, drag,
  scroll, and coordinate actions use one persistent XDG Remote Desktop plus
  ScreenCast session.
- XWayland is never used silently for a native Wayland desktop. An explicit
  opt-in remains available for unusual compositor setups.

Desktop permission requests are invocation-scoped. Merely opening or focusing
a chat does not capture the screen, open Picture-in-Picture, or wake the pet.
After an approved Computer Use state request, Picture-in-Picture reuses that
request's screenshot and never starts a second capture session.

Linux capture returns the full desktop rather than a cropped app window because
Sky and the portal do not expose a reliable cross-display crop under mixed
scaling. The accessibility tree remains scoped to the approved app.

A compositor that does not implement the relevant portal returns an honest
per-operation error. GNOME, KDE, and other desktops may show their own chooser
or permission prompt; the app cannot bypass that security boundary.

## Updates and Apple APIs

Sparkle is the macOS download-and-install updater. It is deliberately disabled
on Linux, no Electron update metadata is published, and Linux packages are
updated by installing a newer release. The renderer's gray “Managed” update row
is an organization-policy message, so the port does not misuse it as a platform
status indicator.

Apple Events are not an MCP system. In this app they are a private transport to
the macOS Computer Use service; Linux bypasses them with the AT-SPI/Sky/portal
bridge above. Apple Reminders and Messages integrations remain Apple-service
features rather than portable desktop APIs.

## Packages

One staged application tree feeds nFPM for Debian, RPM, and Arch packages,
electron-builder for AppImage, Snap, and Flatpak, and the generic tarball used
by the NixOS and Gentoo recipes. Releases use the ten short artifact names listed
in the README, including the build/checksum manifest.

## Codebase summary

The maintained port is about 11,750 physical lines, excluding documentation,
lockfiles, the extracted upstream app, dependencies, and build artifacts:

- 855 lines of TypeScript extract and pin upstream, rebuild native modules, and
  create the shared payload and packages.
- 3,137 lines of JavaScript provide the Linux Electron boundaries, Browser host,
  Picture-in-Picture, notifications, dictation, remote control, and launch path.
- 4,849 lines of Rust implement AT-SPI desktop access, XDG portal control,
  coordinates, screenshots, input, and the small bridge protocols.
- 490 lines form the Linux Computer Use plugin overlay and model-facing client.
- 1,888 lines are focused TypeScript and installed-app smoke tests.
- 535 lines describe package formats, containers, recipes, and release metadata.

## New upstream releases

OpenAI's [official appcast](https://persistent.oaistatic.com/codex-app-prod/appcast.xml)
is checked for a newer macOS archive. Its SHA-256, app path,
version, build number, native-module list, and narrowly accepted extraction
warnings are pinned in `upstream.json`. Assertion-checked bundle patches make the
build stop when upstream moves a boundary, as this release did; each changed
boundary is reviewed and its focused test is updated. A clean container then
rebuilds the native modules, runs the checks, and produces every package from
one payload. The release tag is `upstream-VERSION-port.REVISION`; a new upstream
version starts at port revision 1.

## Verification and limits

The repository has focused unit and static tests for Linux boundaries,
protocols, patch assertions, and package recipes, plus a small installed-app
smoke suite. Release builds verify package metadata and checksums. It does not
attempt a large compositor/browser end-to-end matrix.

This revision is x86-64 only and tied to one upstream archive. The model-facing
Browser Use tool schemas and Computer Use `sky` API match upstream, but the
Linux browser coordinator and desktop backends are compatible
reimplementations rather than Apple's native services. Screenshot framing,
AT-SPI richness, portal behavior, and compositor support can affect practical
reliability, so identical model output quality across every app and desktop is
not guaranteed.

It uses stock
Electron `41.10.3` while that macOS release carries customized Electron
`42.3.0`. Real desktop behavior still varies with keyring state, portal and
compositor support, GPU/audio drivers, and browser installation.

Linux device keys are OS-encrypted but not hardware-nonextractable. A server
policy that requires a hardware-backed key is rejected rather than weakened or
misreported.
