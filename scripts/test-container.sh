#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mode="${1:-local}"
deb="${CODEX_DESKTOP_DEB:-}"

if [ -z "$deb" ]; then
  set -- "$repository"/dist/chatgpt.deb
  if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "Set CODEX_DESKTOP_DEB to exactly one Debian package" >&2
    exit 2
  fi
  deb=$1
fi

case "$mode" in
  local)
    :
    ;;
  live)
    codex_home="${CODEX_LIVE_CODEX_HOME:-$HOME/.codex}"
    if [ ! -d "$codex_home" ]; then
      echo "Authenticated Codex home not found: $codex_home" >&2
      exit 2
    fi
    ;;
  *)
    echo "Usage: $0 [local|live]" >&2
    exit 2
    ;;
esac

if [ -n "${CODEX_NPM_SPEC:-}" ]; then
  docker build --build-arg "CODEX_NPM_SPEC=$CODEX_NPM_SPEC" \
    -t chatgpt-linux-test -f "$repository/test/container/Dockerfile" "$repository"
else
  docker build -t chatgpt-linux-test -f "$repository/test/container/Dockerfile" "$repository"
fi

if [ "$mode" = live ]; then
  # Authentication is copied inside the disposable container; host state stays read-only.
  exec docker run --rm --init \
    --mount "type=bind,src=$deb,dst=/input/package.deb,readonly" \
    --mount "type=bind,src=$codex_home,dst=/input/codex-home,readonly" \
    --env CODEX_LIVE_KEEP_ARTIFACTS \
    --env CODEX_LIVE_KEEP_THREAD \
    --env CODEX_LIVE_TEST_TIMEOUT \
    chatgpt-linux-test live
fi

exec docker run --rm --init \
  --mount "type=bind,src=$deb,dst=/input/package.deb,readonly" \
  chatgpt-linux-test local
