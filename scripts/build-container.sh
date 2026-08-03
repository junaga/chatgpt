#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dmg="${CODEX_DESKTOP_DMG:-$repository/original/ChatGPT.dmg}"
output="${CODEX_DESKTOP_OUTPUT:-$repository/dist}"
build_work=$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-linux-build.XXXXXX")

cleanup() {
  rm -r -- "$build_work"
}
trap cleanup EXIT HUP INT TERM

if [ ! -r "$dmg" ]; then
  echo "DMG not found: $dmg (set CODEX_DESKTOP_DMG)" >&2
  exit 2
fi
mkdir -p "$output"

docker build -t chatgpt-linux-builder -f "$repository/test/container/build.Dockerfile" "$repository"
docker run --rm --init \
  --mount "type=bind,src=$dmg,dst=/input/ChatGPT.dmg,readonly" \
  --mount "type=bind,src=$output,dst=/output" \
  --mount "type=bind,src=$build_work,dst=/work" \
  chatgpt-linux-builder
