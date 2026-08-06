# ChatGPT for Linux

An unofficial x86-64 Linux port of the ChatGPT Codex desktop app.

## Install

Debian, Ubuntu, and related distributions:

```bash
LINK=https://github.com/junaga/chatgpt/releases/latest/download/chatgpt.deb
curl -fL "$LINK" > chatgpt.deb
sudo apt install ./chatgpt.deb
```

APT shows the package as:

> Package: chatgpt
>
> Version: 26.730.61639-1
>
> Architecture: amd64
>
> Description: Experimental ChatGPT Codex desktop compatibility port for Linux.

## Other downloads

- `chatgpt.rpm` — Fedora, RHEL, openSUSE
- `chatgpt.pkg.tar.zst` — Arch Linux
- `chatgpt.AppImage` — AppImage
- `chatgpt.snap` — Snap
- `chatgpt.flatpak` — Flatpak
- `chatgpt.tar.gz` — generic Linux
- `chatgpt.nix` — NixOS recipe
- `chatgpt.ebuild` — Gentoo recipe
- `chatgpt.build.json` — versions and checksums

Browser Use, Computer Use, remote control, notifications, dictation, and
Picture-in-Picture are supported. Wayland runs natively and asks for desktop
access only when a feature needs it. Global shortcuts depend on compositor
support.

## Remote Codex Voice

Use the Linux desktop app as the Remote host when voice continuity matters.
The bare `codex remote-control` host does not run the desktop thread catalog,
timeline ledger, or voice-continuity recorder that reconnecting clients rely
on.

An explicit CLI path overrides the packaged Codex binary, which makes a local
app-server fix testable without rebuilding the whole desktop package:

```bash
CODEX_CLI_PATH=/absolute/path/to/codex chatgpt
```

Install a newer package to update. See [the port report](REPORT.md) for technical
details and known limitations.
