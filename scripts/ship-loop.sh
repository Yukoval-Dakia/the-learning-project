#!/usr/bin/env bash
# ship-loop.sh — resident wrapper: run ship-tick on an interval.
# pnpm ship:start | pnpm ship:stop | pnpm ship:status | pnpm ship:tick
set -u
REPO="/Volumes/YukovalSBak/yukoval-projects/the-learning-project"
cd "$REPO" || exit 1
ROOT=".omc/ship-engine"
PIDF="$ROOT/loop.pid"
LOG="$ROOT/logs/loop.log"
mkdir -p "$ROOT/logs"
INTERVAL="${SHIP_POLL_SECONDS:-900}"
cmd="${1:-status}"

is_running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }

case "$cmd" in
  start)
    if is_running; then echo "ship loop already running (pid $(cat "$PIDF"))"; exit 0; fi
    nohup bash -c "while true; do $REPO/scripts/ship-tick.sh >> $LOG 2>&1; sleep $INTERVAL; done" >> "$LOG" 2>&1 &
    echo $! > "$PIDF"
    echo "ship loop started pid $(cat "$PIDF"), interval ${INTERVAL}s, log $LOG"
    ;;
  stop)
    if is_running; then kill "$(cat "$PIDF")" && rm -f "$PIDF"; echo "stopped"; else echo "not running"; fi
    ;;
  tick)
    exec "$REPO/scripts/ship-tick.sh" "${2:-}"
    ;;
  status)
    if is_running; then echo "running pid $(cat "$PIDF")"; else echo "stopped"; fi
    [ -f "$ROOT/state.json" ] && jq -c '.lanes[] | {issue,state,pr,fix_attempts}' "$ROOT/state.json"
    echo "--- last log ---"; tail -15 "$LOG" 2>/dev/null
    ;;
  *) echo "usage: ship-loop.sh start|stop|tick|status"; exit 1;;
esac
