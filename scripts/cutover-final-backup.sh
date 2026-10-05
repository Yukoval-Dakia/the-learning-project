#!/bin/bash
# YUK-1056 — 统一切换前 final backup + manifest（grounding §14–§15）。
#
# 停全部 writer 后的【只读封存】动作（不写目标库）：
#   1. DLQ/failed/pending tombstone 导出 —— 下个 worker 启动会自清 DLQ，
#      先归档 JSON 档案（YUK-1042 §6 finding-3）；
#   2. pg_dump -Fc 全库快照（staging 原子发布）；
#   3. TOC 完整性核验（容器内 pg_restore -l）；
#   4. migration:capture manifest（REPEATABLE READ READ ONLY，covering §14）；
#   5. cutover-backup manifest —— 工件 sha256/bytes + 队列/订阅处置 +
#      restore-drill 证据引用 + owner_actions 一并封存。
#
# 用法（owner 在 repo root 执行；生产读面 gated）：
#   bash scripts/cutover-final-backup.sh --out=<dir> [--target=<pg-url>] \
#       [--restore-evidence=<drill.json>] [--dry-run] [--skip-*]
#
# 环境覆盖（与 mac-daily-dump.sh 同约定）：
#   LOOM_PG_CONTAINER  默认 the-learning-project-postgres-1
#   LOOM_DB_USER / LOOM_DB_NAME  默认 loom/loom
#   DATABASE_URL 或 --target     migration:capture 目标（默认 localhost:5433 host 端口）
#   LOOM_PG_IMAGE                TOC 核验用镜像（默认从生产容器 inspect）

set -uo pipefail
cd "$(dirname "$0")/.."

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

CONTAINER="${LOOM_PG_CONTAINER:-the-learning-project-postgres-1}"
DB_USER="${LOOM_DB_USER:-loom}"
DB_NAME="${LOOM_DB_NAME:-loom}"
OUT_DIR=""
TARGET="${LOOM_CUTOVER_TARGET:-}"
RESTORE_EVIDENCE=""
DRY_RUN=0
SKIP_DLQ=0
SKIP_DUMP=0
SKIP_CAPTURE=0
SKIP_MANIFEST=0

for arg in "$@"; do
  case "$arg" in
    --out=*) OUT_DIR="${arg#--out=}" ;;
    --target=*) TARGET="${arg#--target=}" ;;
    --restore-evidence=*) RESTORE_EVIDENCE="${arg#--restore-evidence=}" ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-dlq) SKIP_DLQ=1 ;;
    --skip-dump) SKIP_DUMP=1 ;;
    --skip-capture) SKIP_CAPTURE=1 ;;
    --skip-manifest) SKIP_MANIFEST=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "$(date '+%F %T') [cutover-backup] $*" >&2; }

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${OUT_DIR:-cutover-backup-$STAMP}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
DUMP="$OUT_DIR/loom-cutover-$STAMP.dump"
DLQ_JSON="$OUT_DIR/dlq-tombstones-$STAMP.json"
CAPTURE_DIR="$OUT_DIR/capture"

# host 侧 DB 连接（mac compose 发布 127.0.0.1:5433；DATABASE_URL 覆盖）。
TARGET="${TARGET:-${DATABASE_URL:-postgres://loom:loom@127.0.0.1:5433/loom}}"

fail() { log "FAIL: $1"; exit 1; }

log "out: $OUT_DIR | container: $CONTAINER | target: …@${TARGET##*@}"

if [ "$DRY_RUN" -eq 1 ]; then
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER" \
    && log "preflight: $CONTAINER running" \
    || log "preflight: $CONTAINER NOT running (dump/dlq 阶段会失败)"
  command -v pnpm >/dev/null && log "preflight: pnpm present" || log "preflight: pnpm MISSING"
  log "dry-run — 不写任何工件"
  exit 0
fi

docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER" \
  || fail "postgres container $CONTAINER not running"

IMG="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
IMG="${LOOM_PG_IMAGE:-${IMG:-pgvector/pgvector:0.8.2-pg16-bookworm}}"
log "pg image: $IMG"

# ── 1. DLQ tombstone 导出（worker 启动自清前的档案） ──
if [ "$SKIP_DLQ" -eq 0 ]; then
  docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -XAt -c "
    select coalesce(json_agg(j order by j.name, j.state, j.id), '[]'::json)::text
    from pgboss.job j
    where j.state in ('failed','retry','created','active','cancelled')
       or j.name like '%\_dlq'" >"$DLQ_JSON" || fail "dlq export"
  ROWS="$(node -e "const a=require('$DLQ_JSON');console.log(Array.isArray(a)?a.length:0)" 2>/dev/null || echo 0)"
  log "dlq tombstones: $ROWS rows -> $DLQ_JSON"
fi

# ── 2. pg_dump -Fc（staging → 原子发布） ──
if [ "$SKIP_DUMP" -eq 0 ]; then
  docker exec -i "$CONTAINER" pg_dump -Fc -U "$DB_USER" "$DB_NAME" >"$DUMP.tmp" \
    2>"$OUT_DIR/pgdump.err" || { rm -f "$DUMP.tmp"; fail "pg_dump" ; }
  mv "$DUMP.tmp" "$DUMP"
  SIZE="$(stat -f%z "$DUMP")"
  [ "$SIZE" -gt 102400 ] || fail "dump too small ($SIZE)"
  log "dump: $DUMP ($SIZE bytes)"
fi

# ── 3. TOC 完整性核验 ──
TOC=""
if [ "$SKIP_DUMP" -eq 0 ]; then
  TOC="$(docker run --rm -i "$IMG" sh -c 'cat > /tmp/d.dump && pg_restore -l /tmp/d.dump | wc -l' <"$DUMP" 2>>"$OUT_DIR/pgdump.err" | tr -d '[:space:]')"
  [[ "$TOC" =~ ^[0-9]+$ ]] || fail "TOC unreadable"
  log "toc entries: $TOC"
fi

# ── 4. migration capture（§14 观测清单） ──
if [ "$SKIP_CAPTURE" -eq 0 ]; then
  pnpm exec tsx scripts/migration-capture.ts --out="$CAPTURE_DIR" --target="$TARGET" \
    || fail "migration:capture"
  log "capture: $CAPTURE_DIR/latest.json"
fi

# ── 5. cutover manifest ──
if [ "$SKIP_MANIFEST" -eq 0 ]; then
  ARGS=(--out="$OUT_DIR" --git-sha="$(git rev-parse HEAD 2>/dev/null || echo '')")
  [ "$SKIP_CAPTURE" -eq 0 ] && ARGS+=(--capture-dir="$CAPTURE_DIR")
  [ "$SKIP_DUMP" -eq 0 ] && ARGS+=(--dump="$DUMP")
  [ -n "$TOC" ] && ARGS+=(--toc-entries="$TOC")
  [ "$SKIP_DLQ" -eq 0 ] && ARGS+=(--dlq="$DLQ_JSON")
  [ -n "$RESTORE_EVIDENCE" ] && ARGS+=(--restore-evidence="$RESTORE_EVIDENCE")
  pnpm exec tsx scripts/cutover-backup.ts "${ARGS[@]}" || fail "cutover-backup manifest"
fi

cat >"$OUT_DIR/OWNER-ACTIONS.txt" <<'EOF'
统一切换 runbook 前置 owner 动作（YUK-1056）：
1. restore 演练：scripts/restore-drill.sh --dump=<本目录的 .dump> → 证据 JSON 归档；
   再跑 cutover-backup.ts --restore-evidence=<evidence.json> 刷新 manifest。
2. DLQ group A 裁决：memory_event_ingest_dlq 8 条 add_started —— (a) verify-then-release
   重 ingest 或 (b) 接受缺席；裁决记录在 manifest dlq_dispositions。
3. worker 启动会自清 DLQ —— 本目录 dlq-tombstones-*.json 是唯一档案。
4. 进入 preparing 前核验 manifest queues/owner_actions 对账一致。
EOF

log "done — artifacts in $OUT_DIR (见 OWNER-ACTIONS.txt)"
exit 0
