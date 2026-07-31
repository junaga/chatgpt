#!/bin/sh
set -eu

PORT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ANALYSIS_DIR="$(dirname -- "$PORT_DIR")"
MAC_RESOURCES="$ANALYSIS_DIR/extracted/ChatGPT Installer/ChatGPT.app/Contents/Resources"
ELECTRON_DIST="$PORT_DIR/node_modules/electron/dist"
OUTPUT_DIR="$ANALYSIS_DIR/dist"
STAGE_DIR="$(mktemp -d)"
PKG_ROOT="$STAGE_DIR/codex-desktop-linux_26.727.40816-1_amd64"

cleanup() {
  rm -rf -- "$STAGE_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p \
  "$PKG_ROOT/DEBIAN" \
  "$PKG_ROOT/opt/codex-desktop-linux/resources/app" \
  "$PKG_ROOT/usr/bin" \
  "$PKG_ROOT/usr/share/applications" \
  "$PKG_ROOT/usr/share/icons/hicolor/512x512/apps" \
  "$OUTPUT_DIR"

cp -a "$ELECTRON_DIST/." "$PKG_ROOT/opt/codex-desktop-linux/"
mv "$PKG_ROOT/opt/codex-desktop-linux/electron" "$PKG_ROOT/opt/codex-desktop-linux/codex-desktop"
cp -a "$ANALYSIS_DIR/extracted/app-asar" "$PKG_ROOT/opt/codex-desktop-linux/resources/app/vendor-app"
cp "$PORT_DIR/launcher.cjs" "$PORT_DIR/package.json" "$PKG_ROOT/opt/codex-desktop-linux/resources/app/"
cp -a "$MAC_RESOURCES/plugins" "$PKG_ROOT/opt/codex-desktop-linux/resources/plugins"
cp "$PORT_DIR/packaging/control" "$PKG_ROOT/DEBIAN/control"
cp "$PORT_DIR/packaging/codex-desktop" "$PKG_ROOT/usr/bin/codex-desktop"
cp "$PORT_DIR/packaging/codex-desktop.desktop" "$PKG_ROOT/usr/share/applications/codex-desktop.desktop"
cp "$MAC_RESOURCES/icon-chatgpt.png" "$PKG_ROOT/usr/share/icons/hicolor/512x512/apps/codex-desktop.png"

chmod 0755 "$PKG_ROOT/usr/bin/codex-desktop" "$PKG_ROOT/opt/codex-desktop-linux/codex-desktop"
chmod 4755 "$PKG_ROOT/opt/codex-desktop-linux/chrome-sandbox"
chmod 0644 "$PKG_ROOT/usr/share/applications/codex-desktop.desktop" "$PKG_ROOT/usr/share/icons/hicolor/512x512/apps/codex-desktop.png"

dpkg-deb --root-owner-group -Zgzip -z1 --build "$PKG_ROOT" "$OUTPUT_DIR/codex-desktop-linux_26.727.40816-1_amd64.deb"
