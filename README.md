# ChatGPT for Linux

An experimental Linux build of the ChatGPT Codex desktop app. This is an
independent project, not an official OpenAI release.

## Install

Debian, Ubuntu, and related distributions:

```bash
LINK=https://github.com/junaga/chatgpt-linux/releases/latest/download/chatgpt-linux.deb
curl -fL "$LINK" > chatgpt-linux.deb
sudo apt install ./chatgpt-linux.deb
```

The Codex CLI must also be installed and signed in. Start the app with
`chatgpt` or from the desktop menu.

## Downloads

- Debian and Ubuntu: `chatgpt-linux.deb`
- Fedora, RHEL, and openSUSE: `chatgpt-linux.rpm`
- Arch Linux: `chatgpt-linux.pkg.tar.zst`
- NixOS: `packaging/nix/default.nix`
- Gentoo: `packaging/gentoo/chatgpt-26.727.40816_p4.ebuild`
- Generic Linux files: `chatgpt-linux.tar.gz`

AppImage, Snap, and Flatpak downloads are not built yet.

## Status

The main app works: conversations, projects, file editing, Git, terminals,
plugins, skills, MCP, automations, SSH connections, notifications, and links.

Computer use and browser control are not ported. See [REPORT.md](REPORT.md) for
technical details.

## Build

This checkout supports the exact ChatGPT DMG recorded in `upstream.json`.

```bash
npm ci
npm run port:container
```

Artifacts are written to `dist/`. Run the small repository checks with
`npm test`.
