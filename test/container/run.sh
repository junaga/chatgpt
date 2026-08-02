#!/bin/sh
set -eu

package=/input/package.deb
if [ ! -r "$package" ]; then
  echo "Mount the Debian package at /input/package.deb" >&2
  exit 2
fi

dpkg -i "$package" >/dev/null
mode="${1:-local}"

case "$mode" in
  local)
    exec runuser -u node -- xvfb-run -a npm test --prefix /workspace/desktop
    ;;
  live)
    if [ ! -d /input/codex-home ]; then
      echo "Live mode requires an authenticated Codex home mounted at /input/codex-home" >&2
      exit 2
    fi
    cp -a /input/codex-home /home/node/.codex
    chown -R node:node /home/node/.codex
    exec runuser -u node -- env CODEX_LIVE_TEST=1 CODEX_LIVE_CODEX_HOME=/home/node/.codex \
      xvfb-run -a npm run test:live --prefix /workspace/desktop
    ;;
  *)
    echo "Usage: run-port-tests [local|live]" >&2
    exit 2
    ;;
esac
