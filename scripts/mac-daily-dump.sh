#!/bin/bash
# YUK-992 — Mac 本地生产日级 pg_dump。
#
# 背景：09-12 主机盘写满 → OrbStack VM 崩溃 → docker 存储全清（含生产 pgdata 卷），
# 恢复只能靠 4 天前的手动 per-lane dump。本脚本由 launchd 每日 07:15（Asia/Shanghai）
# 触发——避开 03:00-05:00 维护 cron 带，且晚于 05:50 供给 planner 链，dump 捕捉整夜产出。
#
# 安装（一次性）：
#   cp scripts/launchd/studio.yukoval.loom-daily-dump.plist ~/Library/LaunchAgents/
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/studio.yukoval.loom-daily-dump.plist
# 验证：
#   scripts/mac-daily-dump.sh            # 立即手动跑一份（幂等，同日覆盖）
#   cat …/tlp-local-prod-*/.loom-daily-dump-last-success
#
# 失败发现面（ticket 要求的告警机制）：
#   - 成功：写 .loom-daily-dump-last-success（epoch 戳）；连续 2 日戳未更新 = 失败。
#   - 失败：写 .loom-daily-dump-FAILED-YYYYMMDD 标记文件（恢复演练 lane / PLAN 巡检可见）。
#   - 全量日志：loom-daily-dump.log（同一目录）。

set -uo pipefail

# launchd 默认 PATH 不含 /usr/local/bin（docker CLI 在 OrbStack xbin 的软链）。
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

RUNTIME_DIR="/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU"
CONTAINER="the-learning-project-postgres-1"
DB_USER="loom"
DB_NAME="loom"
KEEP_DAILY=14
MIN_BYTES=102400 # 100KB——空库/坏 dump 防御（现体量 ~2.5MB）
STAMP="$RUNTIME_DIR/.loom-daily-dump-last-success"
LOG="$RUNTIME_DIR/loom-daily-dump.log"

DATE="$(date +%Y%m%d)"
OUT="$RUNTIME_DIR/loom-daily-$DATE.dump"
FAILED_MARK="$RUNTIME_DIR/.loom-daily-dump-FAILED-$DATE"

log() { echo "$(date '+%F %T') $*" >>"$LOG"; }

fail() {
  log "FAIL: $1"
  : >"$FAILED_MARK"
  exit 0 # launchd 不刷屏；标记文件 + 缺失的 success 戳即告警面
}

# docker daemon 或容器不在（VM 重启/栈未起）→ 标记失败，明日再来。
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  fail "container $CONTAINER not running (daemon or stack down)"
fi

if ! docker exec "$CONTAINER" pg_dump -Fc -U "$DB_USER" "$DB_NAME" >"$OUT.tmp" 2>>"$LOG"; then
  rm -f "$OUT.tmp"
  fail "pg_dump exit non-zero (see $LOG)"
fi

SIZE="$(stat -f%z "$OUT.tmp")"
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  rm -f "$OUT.tmp"
  fail "dump too small ($SIZE bytes < $MIN_BYTES) — refusing to keep"
fi

mv "$OUT.tmp" "$OUT"
rm -f "$FAILED_MARK"
date +%s >"$STAMP"
log "OK: $OUT ($SIZE bytes)"

# 保留策略：最近 KEEP_DAILY 份日级全留；更老的里每月 1 号归档不动，其余删除。
COUNT=0
ls -t "$RUNTIME_DIR"/loom-daily-*.dump 2>/dev/null | while read -r f; do
  COUNT=$((COUNT + 1))
  [ "$COUNT" -le "$KEEP_DAILY" ] && continue
  base="$(basename "$f")"
  day="${base#loom-daily-}"
  day="${day%.dump}"
  if [ "${day:6:2}" = "01" ]; then
    continue # 每月 1 号归档
  fi
  rm -f "$f"
  log "pruned: $f"
done
