#!/bin/bash
# Measure the natural (no locks) startup-tail duration of the built worker.
set -u
cd "$(dirname "$0")/.."
export DATABASE_URL='postgres://qa:qa@127.0.0.1:55432/yuk980_qa'
LOG=.yuk980-evidence/boot-timing.log
: >"$LOG"
node dist/worker.cjs >>"$LOG" 2>&1 &
WPID=$!
mark() { echo "$(date +%s) $1"; }
T0=$(date +%s)
mark "spawned"
for i in $(seq 1 200); do
  grep -q 'capability tools registered' "$LOG" 2>/dev/null && { mark "capability tools registered"; break; }; sleep 0.2
done
for i in $(seq 1 300); do
  grep -q 'running, handlers registered' "$LOG" 2>/dev/null && { mark "READY (startBossWorker returned)"; break; }; sleep 0.2
done
T1=$(date +%s)
echo "natural tail (capability-registered -> ready) plus boot = $((T1-T0))s total"
kill -TERM "$WPID" 2>/dev/null
wait "$WPID"; echo "post-ready SIGTERM exit=$?"
