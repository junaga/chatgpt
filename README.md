# ChatGPT for Linux

An unofficial x86-64 Linux port of the ChatGPT Codex desktop app.

## Install

Debian, Ubuntu, and related distributions:

```bash
LINK=https://github.com/junaga/chatgpt-linux/releases/latest/download/chatgpt.deb
curl -fL "$LINK" > chatgpt.deb
sudo apt install ./chatgpt.deb
```

APT shows the package as:

> Package: chatgpt
>
> Version: 26.727.40816-7
>
> Architecture: amd64
>
> Description: Experimental ChatGPT Codex desktop compatibility port for Linux.

## Downloads

- Debian/Ubuntu — `chatgpt.deb`
- Fedora/RHEL/openSUSE — `chatgpt.rpm`
- Arch Linux — `chatgpt.pkg.tar.zst`
- AppImage — `chatgpt.AppImage`
- Snap — `chatgpt.snap`
- Flatpak — `chatgpt.flatpak`
- Generic Linux — `chatgpt.tar.gz`
- NixOS recipe — `chatgpt.nix`
- Gentoo recipe — `chatgpt.ebuild`

The app includes its Codex runtime. Browser Use, Computer Use, remote control,
notifications, and dictation have Linux implementations. Wayland desktop access
uses your compositor's portals; global shortcuts depend on compositor support.
The macOS in-app updater is intentionally disabled—install a newer package to
update.

See [the port report](REPORT.md) for details. Build with `npm run port:container`
and run the small unit/static checks with `npm test`.
