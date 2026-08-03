# ChatGPT for Linux

An experimental Linux build of the ChatGPT Codex desktop app. This is an
independent project, not an official OpenAI release.

## Install

Debian, Ubuntu, and related distributions:

```bash
LINK=https://github.com/junaga/chatgpt-linux/releases/latest/download/chatgpt.deb
curl -fL "$LINK" > chatgpt.deb
sudo apt install ./chatgpt.deb
```

The Codex CLI must also be installed and signed in. Start the app with
`chatgpt` or from the desktop menu.

## Downloads

- Debian and Ubuntu: `chatgpt.deb`
- Fedora, RHEL, and openSUSE: `chatgpt.rpm`
- Arch Linux: `chatgpt.pkg.tar.zst`
- NixOS: `packaging/nix/default.nix`
- Gentoo: `packaging/gentoo/chatgpt-26.727.40816_p5.ebuild`
- Generic Linux files: `chatgpt.tar.gz`

AppImage, Snap, and Flatpak downloads are not built yet.

## Status

The main app works. Browser control uses a dedicated Chromium profile selected
by `BROWSER`. Computer Use works on Xorg; native Wayland support is not ready.
In-app updates are disabled—update ChatGPT with your Linux package manager.

See [REPORT.md](REPORT.md) for remaining platform differences.

## Build

This checkout supports the exact ChatGPT DMG recorded in `upstream.json`.

```bash
npm ci
npm run port:container
```

Artifacts are written to `dist/`. Run the small repository checks with
`npm test`.
