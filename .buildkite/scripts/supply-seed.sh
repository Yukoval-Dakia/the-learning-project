#!/usr/bin/env bash
# YUK-914 supply seed step (manual): SUPPLY_SEED=1 materializes the
# integrity-pinned runtime closure and loader, uploads the exact digest-named
# artifacts, and emits a machine-readable seed receipt as Buildkite metadata.
# The receipt is recorded by a lead in .buildkite/supply/runtime-artifact-pins.json.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if [ "${SUPPLY_SEED:-}" != "1" ]; then
  echo "supply-seed: refusing to run without SUPPLY_SEED=1 (this step is manual; the required offline gate runs on normal builds)" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "supply-seed: node is required on the queue image (see .buildkite/README.md - Troubleshooting)" >&2
  exit 1
fi

exec node scripts/ci/supply-artifact-produce.mjs --upload
