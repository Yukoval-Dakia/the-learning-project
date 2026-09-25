#!/bin/bash
# YUK-992 — Mac 本地生产日级 pg_dump（YUK-1041 修复版）。
#
# 背景：09-12 主机盘写满 → OrbStack VM 崩溃 → docker 存储全清（含生产 pgdata 卷），
# 恢复只能靠 4 天前的手动 per-lane dump。本脚本由 launchd 每日 07:15
# 触发——避开 03:00-05:00 维护 cron 带，且晚于 05:50 供给 planner 链，dump 捕捉整夜产出。
#
# YUK-1041 根因（勿回退此结构）：
#   launchd 子进程被 macOS TCC/sandbox 拒绝对 /Volumes/*（外置盘）的任何 I/O——
#   连 ls/read 都 EPERM；execve 盘上的可执行文件则 "spawn failed"（EX_CONFIG 78/126）。
#   09-13 手工验证成功是因为终端进程已持 Removable Volumes 授权；launchd 上下文
#   从未成功过一次（runs=12 全灭，launchd.log 从未被创建）。
#   因此本版：
#     1. 脚本必须装在内置盘（INSTALL_DIR），launchd 才能 exec；
#     2. 对 runtime 目录（外置盘）的一切读/写/枚举全部经 `docker run -v …:/backup`
#        在容器内完成——OrbStack virtiofs 由 daemon 侧代理文件 I/O，不吃 TCC；
#     3. pg_dump 先经 socket 落本地 staging，再 docker -i stdin 流进容器落盘（原子 mv）。
#
# 安装（一次性，或脚本更新后重跑）：
#   mkdir -p ~/Library/Application\ Support/loom-daily-dump
#   cp scripts/mac-daily-dump.sh ~/Library/Application\ Support/loom-daily-dump/
#   chmod +x ~/Library/Application\ Support/loom-daily-dump/mac-daily-dump.sh
#   cp scripts/launchd/studio.yukoval.loom-daily-dump.plist ~/Library/LaunchAgents/
#   launchctl bootout gui/$(id -u)/studio.yukoval.loom-daily-dump  # 若已装载
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/studio.yukoval.loom-daily-dump.plist
#
# 验证 / stale 巡检（>2 日戳未更新或 exit 非 0 即故障）：
#   cat …/tlp-local-prod-*/.loom-daily-dump-last-success          # epoch 戳
#   launchctl print gui/$(id -u)/studio.yukoval.loom-daily-dump | grep -E 'last exit|runs'
#   ~/Library/Application\ Support/loom-daily-dump/mac-daily-dump.sh   # 手动补一份（幂等，同日覆盖）
#
# 失败发现面：
#   - 成功：写 .loom-daily-dump-last-success（epoch 戳）；连续 2 日戳未更新 = 失败。
#   - 失败：写 .loom-daily-dump-FAILED-YYYYMMDD 标记文件（docker daemon/容器死时写不进，
#     此时 staleness 戳是唯一信号——两者互备）。
#   - 脚本内日志：loom-daily-dump.log（runtime 目录，容器侧 append）；
#     launchd stdout/stderr：INSTALL_DIR/launchd.log（内置盘）。

set -uo pipefail

# launchd 默认 PATH 不含 /usr/local/bin（docker CLI 在 OrbStack xbin 的软链）。
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

RUNTIME_DIR="/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU"
CONTAINER="the-learning-project-postgres-1"
DB_USER="loom"
DB_NAME="loom"
KEEP_DAILY=14
MIN_BYTES=102400 # 100KB——空库/坏 dump 防御（现体量 ~7.7MB）

DATE="$(date +%Y%m%d)"
DUMP_NAME="loom-daily-$DATE.dump"
FAILED_MARK=".loom-daily-dump-FAILED-$DATE"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loom-daily-dump.XXXXXX")"
STAGE_DUMP="$STAGE_DIR/$DUMP_NAME"
PG_ERR="$STAGE_DIR/pgdump.err"
IMG=""

cleanup() { rm -rf "$STAGE_DIR"; }
trap cleanup EXIT

img() { # 解析目标容器镜像（必在本地缓存——容器正用它跑）；daemon 死则返回非零
  [ -n "$IMG" ] || IMG="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null)"
  [ -n "$IMG" ]
}

volsh() { # 在一次性容器内对 runtime 目录执行 sh -c 脚本（stdin 透传；env 需 -e 显式带进去）
  img && docker run --rm -i \
    -e "TS=${TS:-}" -e "MSG=${MSG:-}" -e "FAILED_MARK=${FAILED_MARK:-}" \
    -e "DUMP_NAME=${DUMP_NAME:-}" -e "KEEP=${KEEP:-}" -e "STAMP=${STAMP:-}" \
    -e "RUNTIME_DIR=${RUNTIME_DIR:-}" -e "SIZE=${SIZE:-}" \
    -v "$RUNTIME_DIR:/backup" "$IMG" sh -c "$1"
}

vlog() { # 追加一行到 runtime 目录的 loom-daily-dump.log
  TS="$(date '+%F %T')" MSG="$1" volsh \
    'printf "%s %s\n" "$TS" "$MSG" >> /backup/loom-daily-dump.log'
}

fail() {
  vlog "FAIL: $1" 2>/dev/null
  FAILED_MARK="$FAILED_MARK" volsh 'printf "" > "/backup/$FAILED_MARK"' 2>/dev/null
  exit 0 # launchd 不刷屏；标记文件 + 停滞的 success 戳即告警面
}

# 前置：daemon 活着、目标容器在跑。
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  # 容器不在 → 连标记文件也写不进去（盘 I/O 只能走 docker），静默退出；
  # .loom-daily-dump-last-success 停滞仍是告警面。
  exit 0
fi

# pg_dump → 本地 staging（经 docker socket 导流——本地盘无 TCC 限制）。
if ! docker exec "$CONTAINER" pg_dump -Fc -U "$DB_USER" "$DB_NAME" >"$STAGE_DUMP" 2>"$PG_ERR"; then
  volsh 'cat >> /backup/loom-daily-dump.log' <"$PG_ERR" 2>/dev/null
  fail "pg_dump exit non-zero"
fi

SIZE="$(stat -f%z "$STAGE_DUMP")"
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  fail "dump too small ($SIZE bytes < $MIN_BYTES) — refusing to keep"
fi

# 发布 + 成功戳 + 清理失败标记 + 保留策略：全部塞进一个容器调用，stdin 是 dump。
# 先落 .tmp 再 mv 保证原子；保留：最近 KEEP_DAILY 份全留，更老的只留每月 1 号。
DUMP_NAME="$DUMP_NAME" FAILED_MARK="$FAILED_MARK" KEEP="$KEEP_DAILY" \
TS="$(date '+%F %T')" STAMP="$(date +%s)" SIZE="$SIZE" \
volsh '
cat > "/backup/$DUMP_NAME.tmp" &&
mv "/backup/$DUMP_NAME.tmp" "/backup/$DUMP_NAME" &&
rm -f "/backup/$FAILED_MARK" &&
printf "%s" "$STAMP" > /backup/.loom-daily-dump-last-success &&
printf "%s OK: %s/%s (%s bytes)\n" "$TS" "$RUNTIME_DIR" "$DUMP_NAME" "$SIZE" >> /backup/loom-daily-dump.log &&
cd /backup &&
count=0 &&
ls -t loom-daily-*.dump 2>/dev/null | while read -r f; do
  count=$((count + 1))
  [ "$count" -le "$KEEP" ] && continue
  dom="$(echo "$f" | cut -c18-19)" # loom-daily-YYYYMMDD.dump → DD
  [ "$dom" = "01" ] && continue
  rm -f "$f"
  printf "%s pruned: %s\n" "$TS" "$f" >> /backup/loom-daily-dump.log
done
' <"$STAGE_DUMP" || fail "publish to runtime dir failed (docker run write)"
