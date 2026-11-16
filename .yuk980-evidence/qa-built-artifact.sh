#!/bin/bash
# YUK-980 built-artifact QA — isolated scratch DB (docker container yuk980-qa-pg,
# empty migrated db yuk980_qa) + the real production artifact `node dist/worker.cjs`.
# No providers touched (echo queue only); no production data.
#
# Lock pacing: docker-exec psql sessions carry a SQL comment marker; release is
# SERVER-SIDE (pg_terminate_backend by marker) because killing the docker exec
# client does not kill the container-side psql (lock would stay held).
#
# Cases:
#   a  pre-consumption SIGTERM (boot blocked on tool_operation lock, before
#      createBoss/boss.start) -> fast exit(1), "boot window", no graceful stop
#   b1 mid-registration SIGTERM (startup tail blocked on ai_task_runs ACCESS
#      EXCLUSIVE; in-flight echo job blocked on an echo_jobs row lock), tail
#      released after the signal -> bounded tail-wait resolves, drain completes
#      the in-flight job, exit(0)
#   b2 same window, tail never released -> 9s bounded wait fires, stop+drain
#      anyway, exit(0)
#   c  ready SIGTERM with in-flight job -> graceful drain, exit(0)
set -u
cd "$(dirname "$0")/.."   # worktree root

export DATABASE_URL='postgres://qa:qa@127.0.0.1:55432/yuk980_qa'
PG="docker exec -i yuk980-qa-pg psql -U qa -d yuk980_qa -v ON_ERROR_STOP=1 -q"
EV=.yuk980-evidence
PASS=0; FAIL=0
WORKER_PID=''; LOCK_PIDS=''

say()  { echo "[qa] $*"; }
ok()   { PASS=$((PASS+1)); say "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); say "FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (got='$2' want='$3')"; fi; }
check_contains(){ if grep -q -- "$3" "$2"; then ok "$1"; else bad "$1 (pattern '$3' not in $2)"; fi; }
check_not_contains(){ if grep -q -- "$3" "$2"; then bad "$1 (pattern '$3' unexpectedly in $2)"; else ok "$1"; fi; }

terminate_marker(){ # server-side kill of lock sessions carrying this marker
  $PG -tA -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname='yuk980_qa' AND query LIKE '%/* $1 */%' AND pid <> pg_backend_pid()" >/dev/null 2>&1
}

cleanup() {
  [ -n "$WORKER_PID" ] && kill -KILL "$WORKER_PID" 2>/dev/null
  for p in $LOCK_PIDS; do kill -KILL "$p" 2>/dev/null; done
  docker exec yuk980-qa-pg psql -U qa -d yuk980_qa -tA -c \
    "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname='yuk980_qa' AND application_name LIKE 'psql%' AND pid <> pg_backend_pid()" >/dev/null 2>&1
}
trap cleanup EXIT

wait_log(){ # file pattern desc [max_s]
  local i max=$((${4:-60})); local maxiter=$((max*4))
  for i in $(seq 1 $maxiter); do
    grep -q -- "$2" "$1" 2>/dev/null && { say "seen: $3"; return 0; }
    sleep 0.25
  done
  bad "timeout waiting for '$3' in $1"; return 1
}

poll_sql(){ # desc sql want [max_s]
  local i val max=$((${4:-60})); local maxiter=$((max*4))
  for i in $(seq 1 $maxiter); do
    val=$($PG -tA -c "$2" 2>/dev/null | head -1)
    [ "$val" = "$3" ] && { say "ok: $1"; return 0; }
    sleep 0.25
  done
  bad "poll_sql timeout: $1 (last='$val' want='$3')"; return 1
}

start_worker(){ # $1 = logfile  (WORKER_PID is a child of this shell)
  node dist/worker.cjs >"$1" 2>&1 &
  WORKER_PID=$!
}

lock_session(){ # $1 = locking sql, $2 = marker
  docker exec -i yuk980-qa-pg psql -U qa -d yuk980_qa -c "BEGIN; $1; SELECT pg_sleep(600) /* $2 */;" >/dev/null 2>&1 &
  LOCK_PIDS="$LOCK_PIDS $!"
}

seed_echo_row(){ $PG -c "INSERT INTO echo_jobs (id,input,status,created_at,updated_at) VALUES ('$1','$2','queued',now(),now()) ON CONFLICT (id) DO NOTHING" >/dev/null; }

# Fresh per-run assertions base: job rows and echo business rows from prior QA
# runs on this scratch DB would inflate the completed-count checks.
$PG -c "TRUNCATE pgboss.job" >/dev/null 2>&1
$PG -c "TRUNCATE echo_jobs" >/dev/null 2>&1

# ── Case a: pre-consumption SIGTERM (boot blocked before createBoss) ────────
say '=== case a: pre-consumption SIGTERM ==='
LOG=$EV/qa-a-preconsumption.log
: >"$LOG"
lock_session 'LOCK TABLE tool_operation IN ACCESS EXCLUSIVE MODE' 'qa-a-recover-lock'
sleep 0.5
start_worker "$LOG"
wait_log "$LOG" 'capability tools registered' 'boot underway (pre-DB)' 30
poll_sql 'boot blocked at recoverToolOperationsOnBoot (pre-consumption)' \
  "SELECT (count(*) >= 1)::int FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%tool_operation%'" "1" 30
kill -TERM "$WORKER_PID"
wait "$WORKER_PID"; RC=$?
WORKER_PID=''
terminate_marker 'qa-a-recover-lock'
check 'a: exit code' "$RC" "1"
check_contains     'a: logs boot window (honest fast exit)' "$LOG" 'boot window'
check_not_contains 'a: no graceful stop attempted'         "$LOG" 'stopping gracefully'
check_not_contains 'a: no tail wait'                       "$LOG" 'waiting up to'

# ── Case b1: mid-registration SIGTERM, tail released after signal ──────────
say '=== case b1: mid-registration SIGTERM, clean bounded tail-wait + drain ==='
LOG=$EV/qa-b1-midregistration.log
: >"$LOG"
lock_session 'LOCK TABLE ai_task_runs IN ACCESS EXCLUSIVE MODE' 'qa-b1-tail-lock'
sleep 0.5
start_worker "$LOG"
wait_log "$LOG" 'capability tools registered' 'boot underway' 30
poll_sql 'tail blocked at ai_task_runs reconcile' \
  "SELECT (count(*) >= 1)::int FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%ai_task_runs%'" "1" 30
seed_echo_row qa-echo-b1 abcd
lock_session "SELECT * FROM echo_jobs WHERE id='qa-echo-b1' FOR UPDATE" 'qa-b1-row-lock'
poll_sql 'b1 row lock held before dispatch' \
  "SELECT (count(*) >= 1)::int FROM pg_stat_activity WHERE query LIKE '%/* qa-b1-row-lock */%' AND wait_event='PgSleep'" "1" 30 || exit 1
node $EV/send-echo.mjs qa-echo-b1 abcd >>"$LOG" 2>&1
poll_sql 'echo job in flight (state=active)' \
  "SELECT count(*) FROM pgboss.job WHERE name='echo' AND state='active' AND data->>'businessId'='qa-echo-b1'" "1" 30 || exit 1
kill -TERM "$WORKER_PID"
sleep 1.5                          # handler is inside the bounded tail wait here
terminate_marker 'qa-b1-tail-lock' # let the startup tail settle
wait_log "$LOG" 'stopping gracefully' 'tail settled, drain started' 30
terminate_marker 'qa-b1-row-lock'  # let the in-flight job finish
wait "$WORKER_PID"; RC=$?
WORKER_PID=''
check 'b1: exit code' "$RC" "0"
check_contains     'b1: waited for the startup tail' "$LOG" 'waiting up to 9000ms'
check_not_contains 'b1: no timeout needed'           "$LOG" 'did not settle within'
check_not_contains 'b1: no false boot-window exit'   "$LOG" 'boot window'
check_contains     'b1: stopped cleanly'             "$LOG" 'stopped cleanly'
poll_sql 'b1: in-flight echo job COMPLETED by the drain' \
  "SELECT count(*) FROM pgboss.job WHERE name='echo' AND state='completed' AND data->>'businessId'='qa-echo-b1'" "1" 30
check 'b1: echo business row updated (output reversed)' \
  "$($PG -tA -c "SELECT output FROM echo_jobs WHERE id='qa-echo-b1'" | head -1)" "dcba"

# ── Case b2: mid-registration SIGTERM, tail NEVER settles (bounded wait fires) ──
say '=== case b2: mid-registration SIGTERM, tail outlives the 9s bound ==='
LOG=$EV/qa-b2-timeout.log
: >"$LOG"
lock_session 'LOCK TABLE ai_task_runs IN ACCESS EXCLUSIVE MODE' 'qa-b2-tail-lock'
sleep 0.5
start_worker "$LOG"
wait_log "$LOG" 'capability tools registered' 'boot underway' 30
poll_sql 'tail blocked at ai_task_runs reconcile' \
  "SELECT (count(*) >= 1)::int FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%ai_task_runs%'" "1" 30
seed_echo_row qa-echo-b2 abcd
lock_session "SELECT * FROM echo_jobs WHERE id='qa-echo-b2' FOR UPDATE" 'qa-b2-row-lock'
poll_sql 'b2 row lock held before dispatch' \
  "SELECT (count(*) >= 1)::int FROM pg_stat_activity WHERE query LIKE '%/* qa-b2-row-lock */%' AND wait_event='PgSleep'" "1" 30 || exit 1
node $EV/send-echo.mjs qa-echo-b2 abcd >>"$LOG" 2>&1
poll_sql 'echo job in flight (state=active)' \
  "SELECT count(*) FROM pgboss.job WHERE name='echo' AND state='active' AND data->>'businessId'='qa-echo-b2'" "1" 30 || exit 1
kill -TERM "$WORKER_PID"
# tail stays locked: the bounded wait must fire at 9s, then stop + drain anyway
wait_log "$LOG" 'did not settle within 9000ms' 'bounded tail wait fired' 30
wait_log "$LOG" 'stopping gracefully' 'drain started after timeout' 30
terminate_marker 'qa-b2-row-lock'
wait "$WORKER_PID"; RC=$?
WORKER_PID=''
terminate_marker 'qa-b2-tail-lock'
sleep 1
check 'b2: exit code' "$RC" "0"
check_contains     'b2: timeout warn present'     "$LOG" 'did not settle within 9000ms'
check_not_contains 'b2: no false boot-window exit' "$LOG" 'boot window'
check_contains     'b2: stopped cleanly'          "$LOG" 'stopped cleanly'
poll_sql 'b2: in-flight echo job COMPLETED despite tail timeout' \
  "SELECT count(*) FROM pgboss.job WHERE name='echo' AND state='completed' AND data->>'businessId'='qa-echo-b2'" "1" 30

# ── Case c: ready SIGTERM with in-flight job ────────────────────────────────
say '=== case c: ready SIGTERM drains in-flight job ==='
LOG=$EV/qa-c-ready.log
: >"$LOG"
start_worker "$LOG"
wait_log "$LOG" 'running, handlers registered' 'worker fully ready' 40
seed_echo_row qa-echo-c abcd
lock_session "SELECT * FROM echo_jobs WHERE id='qa-echo-c' FOR UPDATE" 'qa-c-row-lock'
poll_sql 'ready row lock held before dispatch' \
  "SELECT (count(*) >= 1)::int FROM pg_stat_activity WHERE query LIKE '%/* qa-c-row-lock */%' AND wait_event='PgSleep'" "1" 30 || exit 1
node $EV/send-echo.mjs qa-echo-c abcd >>"$LOG" 2>&1
poll_sql 'echo job in flight (state=active)' \
  "SELECT count(*) FROM pgboss.job WHERE name='echo' AND state='active' AND data->>'businessId'='qa-echo-c'" "1" 30 || exit 1
kill -TERM "$WORKER_PID"
wait_log "$LOG" 'stopping gracefully' 'drain started' 30
terminate_marker 'qa-c-row-lock'
wait "$WORKER_PID"; RC=$?
WORKER_PID=''
check 'c: exit code' "$RC" "0"
check_not_contains 'c: no boot-window path when ready' "$LOG" 'boot window'
check_not_contains 'c: no tail wait when ready'        "$LOG" 'waiting up to'
check_contains     'c: stopped cleanly'                "$LOG" 'stopped cleanly'
poll_sql 'c: in-flight echo job COMPLETED by the drain' \
  "SELECT count(*) FROM pgboss.job WHERE name='echo' AND state='completed' AND data->>'businessId'='qa-echo-c'" "1" 30
check 'c: echo business row updated' \
  "$($PG -tA -c "SELECT output FROM echo_jobs WHERE id='qa-echo-c'" | head -1)" "dcba"

say ''
say "SUMMARY: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
