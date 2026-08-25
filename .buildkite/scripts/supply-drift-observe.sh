#!/usr/bin/env bash
# YUK-914 advisory registry drift observation: reports what the live npm
# registry would resolve today for the drift-prone packages and stores the
# observation as Buildkite metadata. Always exits 0 on observation failures;
# the pipeline step is soft_fail and never decides required success.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if ! command -v node >/dev/null 2>&1; then
  echo "supply-drift-observe: node is required on the queue image (see .buildkite/README.md - Troubleshooting)" >&2
  exit 1
fi

exec node scripts/ci/supply-drift-observe.mjs
