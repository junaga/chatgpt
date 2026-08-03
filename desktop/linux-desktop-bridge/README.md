# Linux desktop bridge

This crate builds two packaged Linux services. The Computer Use service
provides:

- the versioned bridge protocol and the macOS-compatible window action shapes;
- AT-SPI app discovery, accessibility trees/diffs, and semantic actions;
- active XDG Screenshot and persistent RemoteDesktop control on Wayland;
- the protocol used by the plugin to combine AT-SPI with the bundled upstream
  `@oai/sky` X11 screenshot/input client;
- multi-monitor logical/frame coordinate transforms; and
- stable accessibility element IDs and structural tree diffs.

The packaged bridge binary also owns Linux global-dictation platform work:

- XDG GlobalShortcuts sessions with both activation and deactivation events on
  Wayland;
- modifier-release tracking through the X11 keymap; and
- persisted XDG RemoteDesktop keyboard authorization for Wayland paste.

On X11, screenshots and raw input use the Linux client already shipped in
`@oai/sky`. On Wayland, screenshots use the Screenshot portal and raw input
uses a compositor-authorized RemoteDesktop session with monitor stream geometry
for absolute coordinates. The restore token is private to the user and can be
revoked through the desktop's permission settings.

Unlike the macOS window capture, both Linux screenshot paths currently return
full-desktop content. Cropping an app safely would require authoritative
per-display pixel/logical transforms; AT-SPI bounds plus portal images are not
enough on negative-origin or mixed-scale layouts.

The Wayland implementation does not silently control XWayland. Compositors
without RemoteDesktop support (notably some wlroots portal setups) return an
explicit backend error. AT-SPI semantic actions continue to work when the app
exports accessibility data. PipeWire frame consumption and EIS are not claimed;
the current implementation uses the standard Screenshot and RemoteDesktop
notification methods.

Run the unit tests with:

```sh
cargo test --all-features
```
