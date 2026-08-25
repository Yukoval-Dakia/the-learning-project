#!/usr/bin/env bash
# YUK-918 native DB shard step: download the selector manifest through
# `buildkite-agent artifact download --step db-select`, verify its schema,
# digest, freshness, and shard plan, then run this shard's slice through the
# existing db-affected runner. A corrupt or tampered manifest fails closed; a
# missing, stale, or expired manifest deterministically falls back to the
# full sharded DB suite (never an empty green).
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

: "${BUILDKITE_PARALLEL_JOB:?BUILDKITE_PARALLEL_JOB is required (step runs with parallelism)}"
: "${BUILDKITE_PARALLEL_JOB_COUNT:?BUILDKITE_PARALLEL_JOB_COUNT is required}"
: "${BUILDKITE_COMMIT:?BUILDKITE_COMMIT is required}"

shard_index="$((BUILDKITE_PARALLEL_JOB + 1))"
shard="${shard_index}/${BUILDKITE_PARALLEL_JOB_COUNT}"

node scripts/ci/db-artifact-shard.mjs \
  --manifest .cache/ci/db-manifest.json \
  --artifact-step db-select \
  --shard "$shard" \
  --execution ".cache/ci/db-execution-shard-${shard_index}.json" \
  --expect-head "$BUILDKITE_COMMIT"
