#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository"

if [ "$(git branch --show-current)" != "main" ]; then
  echo "Releases must be published from main." >&2
  exit 2
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Commit local changes before publishing a release." >&2
  exit 2
fi

git fetch origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "Local main must match origin/main." >&2
  exit 2
fi

npm test
npm run port:container

manifest="$repository/dist/chatgpt.build.json"
version=$(node -e 'const value=require(process.argv[1]); process.stdout.write(value.upstreamVersion)' "$manifest")
revision=$(node -e 'const value=require(process.argv[1]); process.stdout.write(String(value.portRevision))' "$manifest")
tag="upstream-$version-port.$revision"

if gh release view "$tag" --repo junaga/chatgpt >/dev/null 2>&1; then
  echo "Release already exists: $tag" >&2
  exit 2
fi

gh release create "$tag" "$repository"/dist/chatgpt.* \
  --repo junaga/chatgpt \
  --target "$(git rev-parse HEAD)" \
  --title "ChatGPT $version for Linux (port revision $revision)" \
  --generate-notes
