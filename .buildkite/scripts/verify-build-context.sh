#!/usr/bin/env bash
# YUK-916 Green Bridge - checkout identity verification step.
#
# Runs as the first step of .buildkite/pipeline.yml: verifies BUILDKITE_COMMIT
# equals the checked-out HEAD, resolves the HEAD tree and base merge-base,
# compares GitHub-provided SHAs when present, enforces the pins freshness gate,
# emits one JSON record, and stores it in Buildkite metadata.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if ! command -v node >/dev/null 2>&1; then
  echo "green-bridge: node is required on the queue image (see .buildkite/README.md - Troubleshooting)" >&2
  exit 1
fi

exec node scripts/ci/verify-build-context.mjs
