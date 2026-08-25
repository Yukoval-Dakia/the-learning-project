#!/usr/bin/env bash
# YUK-918 native DB selector step: select DB tests once, seal the selection
# into a digest-covered manifest, and upload it through `buildkite-agent
# artifact upload`. Every shard then downloads and verifies the exact same
# manifest; no GitHub importer upload-artifact handoff is involved.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

pins_file="${PINS_FILE:-.buildkite/pins.env}"
# shellcheck source=/dev/null
source "$pins_file"

if ! command -v pnpm >/dev/null 2>&1; then
  npm install --global "pnpm@${PNPM_VERSION:?PNPM_VERSION missing in pins file}"
fi
pnpm install --frozen-lockfile

default_branch="${BUILDKITE_PIPELINE_DEFAULT_BRANCH:-main}"
base="$(git merge-base HEAD "origin/${default_branch}")"
echo "db-select: base merge-base against origin/${default_branch}: ${base}"

node scripts/ci/db-affected.mjs select \
  --base "$base" \
  --mode affected \
  --output .cache/ci/db-selection.json

node scripts/ci/db-artifact-manifest-cli.mjs build \
  --selection .cache/ci/db-selection.json \
  --output .cache/ci/db-manifest.json \
  --shards 2

buildkite-agent artifact upload .cache/ci/db-manifest.json
