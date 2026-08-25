#!/usr/bin/env bash
# YUK-914 required offline supply-chain gate: downloads the digest-pinned
# closure and loader from the recorded seed build via buildkite-agent,
# verifies archive/manifest/loader/graphs, and runs the real loader fully
# offline under the network sentinel. Fails closed (hard RED) while
# .buildkite/supply/runtime-artifact-pins.json is in the seedRequired bootstrap
# state or any verification fails. Never touches the npm registry.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if [ "${SUPPLY_SEED:-}" = "1" ]; then
  echo "supply-consume: the required offline gate never runs in a SUPPLY_SEED=1 seed build" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "supply-consume: node is required on the queue image (see .buildkite/README.md - Troubleshooting)" >&2
  exit 1
fi

exec node scripts/ci/supply-artifact-consume.mjs --from-pins
