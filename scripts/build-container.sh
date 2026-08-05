#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive="${CODEX_DESKTOP_ARCHIVE:-$repository/original/ChatGPT-26.730.61639.zip}"
output="${CODEX_DESKTOP_OUTPUT:-$repository/dist}"
scratch_root="${CODEX_DESKTOP_WORK_ROOT:-$repository/.work}"
mkdir -p "$scratch_root"
build_work=$(mktemp -d "$scratch_root/container.XXXXXX")
mkdir -p "$build_work/tmp"

set --
if [ -n "${CODEX_DESKTOP_FORMATS:-}" ]; then
  set -- --formats "$CODEX_DESKTOP_FORMATS"
fi

cleanup() {
  rm -r -- "$build_work"
}
trap cleanup EXIT HUP INT TERM

if [ ! -r "$archive" ]; then
  echo "Upstream archive not found: $archive (set CODEX_DESKTOP_ARCHIVE)" >&2
  exit 2
fi
mkdir -p "$output"

docker build -t chatgpt-linux-builder -f "$repository/test/container/build.Dockerfile" "$repository"
docker run --rm --init \
  --env TMPDIR=/work/tmp \
  --mount "type=bind,src=$archive,dst=/input/ChatGPT.zip,readonly" \
  --mount "type=bind,src=$output,dst=/output" \
  --mount "type=bind,src=$build_work,dst=/work" \
  chatgpt-linux-builder "$@"
