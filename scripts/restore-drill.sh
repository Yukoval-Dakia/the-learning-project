#!/bin/bash
# YUK-1056 — restore 演练 harness（grounding §14–§15：daily dump failure marker +
# restore 证明）。把一份 pg_dump custom 工件在【隔离 scratch 容器】里恢复并核验，
# 产出 JSON 证据；绝不写任何生产容器/库。
#
# 用法：
#   scripts/restore-drill.sh --dump=<loom-YYYYMMDD.dump> [--out=<evidence.json>]
#                            [--image=<pg-image>] [--keep] [--list-only]
#
# 证据 JSON 字段：dump 身份（file/sha256/bytes/toc_entries）、scratch 容器、
# image、duration、table_counts（每表行数）、verified、errors、at。
# cutover-final-backup.sh 经 --restore-evidence 把它封进 final manifest。
#
# 边界（与 mac-daily-dump.sh 同纪律）：本脚本需要【终端上下文】——host 侧
# 读 dump 走 stdin 导流进容器；launchd/TCC 上下文禁用它。

set -uo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

DUMP=""
OUT=""
KEEP=0
LIST_ONLY=0
IMG=""
CONTAINER=""

for arg in "$@"; do
  case "$arg" in
    --dump=*) DUMP="${arg#--dump=}" ;;
    --out=*) OUT="${arg#--out=}" ;;
    --image=*) IMG="${arg#--image=}" ;;
    --keep) KEEP=1 ;;
    --list-only) LIST_ONLY=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "$(date '+%F %T') [restore-drill] $*" >&2; }

if [ -z "$DUMP" ]; then
  echo "usage: $0 --dump=<file.dump> [--out=<evidence.json>] [--image=<img>] [--keep] [--list-only]" >&2
  exit 2
fi
if [ ! -f "$DUMP" ]; then
  log "FAIL: dump not found: $DUMP"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  log "FAIL: docker daemon not available (TCC/launchd 上下文或 daemon 未起)"
  exit 1
fi

# pg image：默认取生产 postgres 容器的镜像（版本对齐）；daemon 拒询时回退 env。
if [ -z "$IMG" ]; then
  IMG="$(docker inspect --format '{{.Config.Image}}' "${LOOM_PG_CONTAINER:-the-learning-project-postgres-1}" 2>/dev/null || true)"
fi
IMG="${IMG:-pgvector/pgvector:0.8.2-pg16-bookworm}"

STAMP="$(date +%Y%m%d-%H%M%S)"
CONTAINER="loom-restore-drill-${STAMP}-$$"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loom-restore-drill.XXXXXX")"
RESTORE_ERR="$STAGE_DIR/pg_restore.err"
EVIDENCE_DIR="$(dirname "$DUMP")"
OUT="${OUT:-$EVIDENCE_DIR/restore-evidence-$STAMP.json}"

cleanup() {
  if [ "$KEEP" -eq 0 ] && [ -n "$CONTAINER" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

log "dump: $DUMP"
log "image: $IMG | scratch: $CONTAINER"

# --list-only：快速核对 TOC（原样走的验证，不建容器）。
if [ "$LIST_ONLY" -eq 1 ]; then
  docker run --rm -i "$IMG" sh -c 'cat > /tmp/d.dump && pg_restore -l /tmp/d.dump | wc -l' <"$DUMP"
  exit $?
fi

DUMP_SHA="$(shasum -a 256 "$DUMP" | awk '{print $1}')"
DUMP_BYTES="$(stat -f%z "$DUMP")"
START_EPOCH="$(date +%s)"

# ── scratch 容器 ──
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=loom -e POSTGRES_PASSWORD=loom -e POSTGRES_DB=loom \
  "$IMG" >/dev/null || { log "FAIL: scratch container start"; exit 1; }

READY=0
for i in $(seq 1 90); do
  # pg_isready 在 initdb 临时 postmaster 阶段也会返回 accepting —— 必须等到
  # 真实 query 可达（临时 server shutdown 与正式 server 之间有空窗）。
  if docker exec "$CONTAINER" psql -U loom -d loom -XAt -c 'select 1' >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  log "FAIL: scratch postgres never became ready"
  exit 1
fi

# ── TOC 完整性（容器内复核，不落 host 读权）。 ──
TOC="$(docker exec -i "$CONTAINER" sh -c 'cat > /tmp/d.dump && pg_restore -l /tmp/d.dump | wc -l' <"$DUMP" 2>>"$RESTORE_ERR" | tr -d '[:space:]')"
if ! [[ "$TOC" =~ ^[0-9]+$ ]] || [ "$TOC" -lt 1 ]; then
  log "FAIL: pg_restore -l TOC unreadable (toc=$TOC)"
  VERIFIED=false
else
  log "TOC entries: $TOC — restoring…"
  if docker exec -i "$CONTAINER" pg_restore -U loom -d loom \
      --clean --if-exists --no-owner --single-transaction --exit-on-error \
      <"$DUMP" 2>>"$RESTORE_ERR"; then
    VERIFIED=true
    log "pg_restore completed"
  else
    VERIFIED=false
    log "FAIL: pg_restore exited non-zero (see evidence errors)"
  fi
fi

# ── 核验：全表行数 + migrations applied + event 样例 ──
TABLE_COUNTS=""
MIGRATIONS=""
EVENT_COUNT=""
if [ "${VERIFIED:-false}" = true ]; then
  TABLE_COUNTS="$(docker exec -i "$CONTAINER" psql -U loom -d loom -XAt -F'|' -c "
    select (nsp.nspname || '.' || c.relname) as table_name, (xpath('/row/count/text()',
      query_to_xml(format('select count(*) as count from %I.%I', nsp.nspname, c.relname), false, true, '')))[1]::text::int as n
    from pg_class c join pg_namespace nsp on nsp.oid = c.relnamespace
    where c.relkind='r' and nsp.nspname in ('public','drizzle','pgboss')
    order by 1" 2>>"$RESTORE_ERR" | awk -F'|' 'NF==2 { printf "%s\"%s\":%s", (n++>0?",":""), $1, $2 }' )"
  TABLE_COUNTS="{${TABLE_COUNTS}}"
  MIGRATIONS="$(docker exec -i "$CONTAINER" psql -U loom -d loom -XAt -c "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null | tr -d '[:space:]' || true)"
  EVENT_COUNT="$(docker exec -i "$CONTAINER" psql -U loom -d loom -XAt -c "select count(*) from public.event" 2>/dev/null | tr -d '[:space:]' || true)"
fi

END_EPOCH="$(date +%s)"
ERR_TAIL="$(tail -c 4000 "$RESTORE_ERR" 2>/dev/null | sed 's/"/\\"/g' | tr '\n' '|' || true)"

# ── 证据 JSON（printf 拼装；table_counts 已是合法 JSON 文本） ──
mkdir -p "$EVIDENCE_DIR" 2>/dev/null || true
printf '{\n' >"$OUT"
printf '  "drill": "loom-restore-drill",\n' >>"$OUT"
printf '  "at": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$OUT"
printf '  "dump": {"file": "%s", "sha256": "%s", "bytes": %s, "toc_entries": %s},\n' \
  "$DUMP" "$DUMP_SHA" "$DUMP_BYTES" "${TOC:-null}" >>"$OUT"
printf '  "image": "%s",\n' "$IMG" >>"$OUT"
printf '  "container": "%s",\n' "$CONTAINER" >>"$OUT"
printf '  "duration_seconds": %s,\n' "$((END_EPOCH - START_EPOCH))" >>"$OUT"
printf '  "migrations_applied": %s,\n' "${MIGRATIONS:-null}" >>"$OUT"
printf '  "event_rows": %s,\n' "${EVENT_COUNT:-null}" >>"$OUT"
printf '  "table_counts": %s,\n' "${TABLE_COUNTS:-\{\}}" >>"$OUT"
printf '  "verified": %s,\n' "${VERIFIED:-false}" >>"$OUT"
printf '  "errors": "%s",\n' "$ERR_TAIL" >>"$OUT"
printf '  "note": "scratch-only; production untouched; dump read via stdin (terminal context required)"\n' >>"$OUT"
printf '}\n' >>"$OUT"

log "evidence: $OUT (verified=${VERIFIED:-false})"
if [ "${VERIFIED:-false}" != true ]; then
  exit 1
fi
exit 0
