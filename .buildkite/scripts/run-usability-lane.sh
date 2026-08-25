#!/usr/bin/env bash
# YUK-917 Green Bridge Phase 2 - native usability lane step.
#
# Runs the real 13-scenario shipped-container suite (tests/usability/
# shipped-container.spec.ts via playwright.usability.config.ts) against the
# built server on :18787, after proving a real headless Chromium launch
# (scripts/ci/usability-probe.mjs). The step's verdict is the manifest gate in
# scripts/ci/usability-lane.mjs: green requires a manifest that proves Chromium
# launched AND exactly 13/13 scenarios executed. A job exit 0 alone is never
# sufficient, and a failed run still writes the manifest before failing.
#
# Expected to pass only on the pinned custom CI image (.buildkite/ci-image);
# on a hosted image without Chromium OS dependencies the probe fails with a
# machine-readable record (see docs/runbooks/buildkite-green-bridge.md).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

# Gate artifacts live in a directory Playwright never cleans: PW wipes its own
# outputDir (test-results/usability) at run start, which would delete a probe
# record written there (proved by a real local run on 2026-08-25).
GATE_DIR="${USABILITY_GATE_DIR:-test-results/usability-gate}"
PROBE_JSON="$GATE_DIR/chromium-probe.json"
REPORT_JSON="$GATE_DIR/report.json"
MANIFEST_JSON="$GATE_DIR/manifest.json"
SERVER_LOG="$GATE_DIR/server.log"
API_PORT="${USABILITY_API_PORT:-18787}"
BASE_URL="http://127.0.0.1:${API_PORT}"
mkdir -p "$GATE_DIR"

for tool in node pnpm runuser; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "usability-lane: '$tool' is required on the queue image; the custom CI image (.buildkite/ci-image) provides it" >&2
    exit 1
  fi
done

echo '--- :pnpm: install dependencies'
pnpm install --frozen-lockfile

echo '--- :chromium: ensure the Playwright Chromium bundle'
pnpm test:usability:install

echo '--- :hammer: build shipped SPA + server'
DATABASE_URL=postgres://placeholder pnpm build

echo "--- :server: boot built server on :${API_PORT}"
SERVER_USER="${USABILITY_SERVER_USER:-pwuser}"
id "$SERVER_USER" >/dev/null
runuser -u "$SERVER_USER" -- env \
  RW_STATIC_DIR=web/dist \
  API_PORT="$API_PORT" \
  INTERNAL_TOKEN=usability-ci-token \
  DATABASE_URL=postgres://placeholder:placeholder@127.0.0.1:1/placeholder \
  node dist/server.cjs >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

healthy=0
for i in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "usability-lane: server process $SERVER_PID exited before becoming healthy" >&2
    cat "$SERVER_LOG"
    exit 1
  fi
  if curl -sf "$BASE_URL/api/health" >/dev/null; then
    echo "usability-lane: server healthy after ${i}s (pid $SERVER_PID)"
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  echo "usability-lane: server never became healthy on $BASE_URL" >&2
  cat "$SERVER_LOG"
  exit 1
fi

echo '--- :mag: prove a real headless Chromium launch'
set +e
node scripts/ci/usability-probe.mjs >"$PROBE_JSON"
PROBE_EXIT=$?
set -e
cat "$PROBE_JSON"
if [ "$PROBE_EXIT" -ne 0 ]; then
  echo "usability-lane: Chromium probe failed (exit $PROBE_EXIT); the manifest gate records it and fails the step" >&2
  USABILITY_PROBE_JSON="$PROBE_JSON" \
  PLAYWRIGHT_JSON_OUTPUT_FILE="$PWD/$REPORT_JSON" \
  USABILITY_MANIFEST_JSON="$MANIFEST_JSON" \
    node scripts/ci/usability-lane.mjs --manifest || true
  exit 1
fi

echo '--- :playwright: run the 13-scenario shipped-container suite'
set +e
CI=1 \
USABILITY_BASE_URL="$BASE_URL" \
PLAYWRIGHT_JSON_OUTPUT_FILE="$PWD/$REPORT_JSON" \
pnpm exec playwright test --config playwright.usability.config.ts --reporter=line,json
PW_EXIT=$?
set -e
echo "usability-lane: playwright exit=$PW_EXIT (the manifest gate decides the step)"

echo '--- :check: manifest gate'
set +e
USABILITY_PROBE_JSON="$PROBE_JSON" \
PLAYWRIGHT_JSON_OUTPUT_FILE="$PWD/$REPORT_JSON" \
USABILITY_MANIFEST_JSON="$MANIFEST_JSON" \
node scripts/ci/usability-lane.mjs --manifest
MANIFEST_EXIT=$?
set -e

exit "$MANIFEST_EXIT"
