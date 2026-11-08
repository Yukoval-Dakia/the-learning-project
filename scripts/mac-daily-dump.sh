#!/bin/bash
# YUK-992 — 日级备份：launchd 在 Mac 上触发，经 ssh 在 NAS 的 TEST 容器里跑三段：
#   1. pg_dump（postgres 容器，custom format）；
#   2. mem0 history.db（worker 容器，SQLite backup API 一致性快照——worker 可能正在写，
#      裸 cp 会撕裂页；源文件不存在=全新库正常态，记 0 字节）；
#   3. storage 对象存储 /data（tar 活拷贝——append-mostly 存储，中途被追加的对象可能
#      内部不一致，接受为日级快照粒度；tar stderr 确认为 GNU file-changed 告警时
#      放行 rc 1，其余非零判失败）。
# NAS sshd 禁 TCP 转发，走 exec channel，无端口转发。
#
# 三段都是学习者私有数据：日志只记文件名/大小/sha256；dump 与 daily-private 内
# 一切文件/目录落盘 chmod go-rwx（owner-only，尊重 umask 不硬编码权限位）。外置盘
# 挂 noowners，权限位不是真正的访问边界——边界是 runtime 目录本身（见运维 runbook operations.md）。
#
# 背景：09-12 主机盘写满 → OrbStack VM 崩溃 → docker 存储全清（含生产 pgdata 卷），
# 恢复只能靠 4 天前的手动 per-lane dump。本脚本由 launchd 每日 07:15
# 触发——避开 03:00-05:00 维护 cron 带，且晚于 05:50 供给 planner 链，dump 捕捉整夜产出。
# Mac 关机时当日不跑（ssh/本机 docker 都不可用），Mac 回来后恢复。
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
#     3. 三段数据经 ssh 落本地 staging，再 docker -i stdin 流进容器落盘（原子 mv）。
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
#   ~/Library/Application\ Support/loom-daily-dump/mac-daily-dump.sh --check
#     # 巡检汇总：fresh 信息（最新 dump/戳龄/FAILED 标记/daily-private 覆盖），exit 0=fresh 1=stale
#
# 失败发现面（YUK-1056 加固）：
#   - 成功：三段全部发布后才写 .loom-daily-dump-last-success（epoch 戳）；
#     连续 2 日戳未更新 = 失败。任一段失败 → FAILED 标记 + 非零退出、戳不写——
#     dump 已发布的留盘，戳滞后本身就表示「今天不完整」。
#   - 失败（容器可达）：写 .loom-daily-dump-FAILED-YYYYMMDD 标记文件 + exit 非 0。
#   - 失败（本机 daemon 不可达——runtime 目录连容器写都做不到）：写【本地】标记
#     INSTALL_DIR/.loom-daily-dump-FAILED-YYYYMMDD + launchd.log + exit 非 0。
#     停滞的 success 戳是第三层兜底信号。
#   - 脚本内日志：loom-daily-dump.log（runtime 目录，容器侧 append）；
#     launchd stdout/stderr：INSTALL_DIR/launchd.log（内置盘）。
#
# 环境覆盖（YUK-1056 去硬编码；默认值 = 当前 NAS 上的 TEST）：
#   LOOM_RUNTIME_DIR   runtime 目录（dump 落盘点）
#   LOOM_PG_CONTAINER  NAS 上的 postgres 容器名
#   LOOM_DB_USER / LOOM_DB_NAME
#   LOOM_WORKER_CONTAINER / LOOM_STORAGE_CONTAINER  history.db 与 /data 所在容器
#   LOOM_KEEP_DAILY / LOOM_MIN_BYTES / LOOM_DUMP_TIMEOUT

set -uo pipefail

# launchd 默认 PATH 不含 /usr/local/bin（docker CLI 在 OrbStack xbin 的软链）。
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

RUNTIME_DIR="${LOOM_RUNTIME_DIR:-/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU}"
CONTAINER="${LOOM_PG_CONTAINER:-the-learning-project-postgres-1}"
DB_USER="${LOOM_DB_USER:-loom}"
DB_NAME="${LOOM_DB_NAME:-loom}"
WORKER_CONTAINER="${LOOM_WORKER_CONTAINER:-the-learning-project-worker-1}"
STORAGE_CONTAINER="${LOOM_STORAGE_CONTAINER:-the-learning-project-test-storage-1}"
KEEP_DAILY="${LOOM_KEEP_DAILY:-14}"
# 低字节地板只挡「根本不是 dump」的垃圾（0 字节/ssh 报错文本）；有效性由
# pg_restore -l 的 TOC 判定（实测全新 schema 空库 ~335KB，远过地板）。
MIN_BYTES="${LOOM_MIN_BYTES:-4096}"
INSTALL_DIR="$HOME/Library/Application Support/loom-daily-dump"
LOCAL_LOG="$INSTALL_DIR/launchd.log"
NAS_SSH=(/usr/bin/ssh -F none -i "$HOME/.ssh/tlp_nas_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o LogLevel=ERROR yukoval@bancho-nb2.local)
DUMP_TIMEOUT="${LOOM_DUMP_TIMEOUT:-1200}" # 每段时限——ssh 假死兜底，超时 kill 走失败路径
# 本机 pg 容器已停（回滚保留），不能 inspect 它；写外置盘固定用这个本地已存在的镜像。
WRITE_IMAGE="pgvector/pgvector:0.8.2-pg16-bookworm"

DATE="$(date +%Y%m%d)"
DUMP_NAME="loom-daily-$DATE.dump"
PRIV_DIR="daily-private/$DATE"
FAILED_MARK=".loom-daily-dump-FAILED-$DATE"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loom-daily-dump.XXXXXX")"
STAGE_DUMP="$STAGE_DIR/$DUMP_NAME"
STAGE_HIST="$STAGE_DIR/history.db"
STAGE_TAR="$STAGE_DIR/storage.tar"
STAGE_SUMS="$STAGE_DIR/SHA256SUMS"
PG_ERR="$STAGE_DIR/pgdump.err"
HIST_ERR="$STAGE_DIR/hist.err"
STOR_ERR="$STAGE_DIR/storage.err"
IMG=""

cleanup() { rm -rf "$STAGE_DIR"; }
trap cleanup EXIT

img() { # 确认固定镜像在本地缓存；daemon 死或镜像缺失返回非零
  if [ -z "$IMG" ] && docker image inspect "$WRITE_IMAGE" >/dev/null 2>&1; then
    IMG="$WRITE_IMAGE"
  fi
  [ -n "$IMG" ]
}

volsh() { # 在一次性容器内对 runtime 目录执行 sh -c 脚本（stdin 透传；env 需 -e 显式带进去）
  img && docker run --rm -i \
    -e "TS=${TS:-}" -e "MSG=${MSG:-}" -e "FAILED_MARK=${FAILED_MARK:-}" \
    -e "DUMP_NAME=${DUMP_NAME:-}" -e "KEEP=${KEEP:-}" -e "STAMP=${STAMP:-}" \
    -e "RUNTIME_DIR=${RUNTIME_DIR:-}" -e "SIZE=${SIZE:-}" -e "SHA=${SHA:-}" \
    -e "PRIV_DIR=${PRIV_DIR:-}" -e "DEST=${DEST:-}" \
    -v "$RUNTIME_DIR:/backup" "$IMG" sh -c "$1"
}

vlog() { # 追加一行到 runtime 目录的 loom-daily-dump.log
  TS="$(date '+%F %T')" MSG="$1" volsh \
    'printf "%s %s\n" "$TS" "$MSG" >> /backup/loom-daily-dump.log'
}

local_mark() { # 内置盘本地标记（容器/daemon 不可达时的 failure marker 兜底）
  mkdir -p "$INSTALL_DIR" 2>/dev/null || return 0
  : >"$INSTALL_DIR/$FAILED_MARK" 2>/dev/null || true
  printf '%s FAIL(local): %s\n' "$(date '+%F %T')" "$1" >>"$LOCAL_LOG" 2>/dev/null || true
}

remote_mark() { # runtime 目录的 FAILED 标记（容器可用时主告警面）；顺手清重跑
                # 残留的 .rtmp 临时名——它们不算备份件（不入 glob/manifest）
  FAILED_MARK="$FAILED_MARK" volsh '
printf "" > "/backup/$FAILED_MARK"
rm -f "/backup/$DUMP_NAME.rtmp" "/backup/$PRIV_DIR/history.db.rtmp" \
      "/backup/$PRIV_DIR/storage.tar.rtmp" "/backup/$PRIV_DIR/SHA256SUMS.rtmp"
' 2>/dev/null
}

fail() { # YUK-1056：失败必须 exit 非 0（launchd 'last exit code' 即告警面）
  vlog "FAIL: $1" 2>/dev/null
  remote_mark 2>/dev/null || true
  local_mark "$1"
  exit 1
}

# run_remote <tag> <远端 stderr 捕获文件> <ssh argv…>：调用方接 stdin/stdout。
# 与 pg_dump 原看门狗同一实现——到点立 .timeout-<tag> 并 kill -9；
# 远端非零退出把 stderr 落 backup 日志后走统一 fail。
# <&0 / </dev/null 必须显式写：函数内 & 后台命令的 stdin 缺省会被 bash 换成
# /dev/null，不显式转接 history 段的远端脚本就喂不进去。
run_remote() {
  local tag="$1" errf="$2"; shift 2
  "$@" <&0 2>"$errf" &
  local pid=$!
  ( sleep "$DUMP_TIMEOUT"; : >"$STAGE_DIR/.timeout-$tag"; kill -9 "$pid" 2>/dev/null ) </dev/null &
  local wpid=$!
  wait "$pid"; local rc=$?
  kill "$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null
  if [ "$rc" -ne 0 ]; then
    volsh 'cat >> /backup/loom-daily-dump.log' <"$errf" 2>/dev/null
    if [ -e "$STAGE_DIR/.timeout-$tag" ]; then
      fail "$tag exceeded ${DUMP_TIMEOUT}s — killed"
    fi
    fail "$tag exit non-zero ($rc)"
  fi
}

# publish_file <stage 文件> <runtime 目录内相对路径>：.tmp→chmod go-rwx→mv 原子发布。
publish_file() {
  DEST="$2" volsh '
cat > "/backup/$DEST.tmp" &&
chmod go-rwx "/backup/$DEST.tmp" &&
mv "/backup/$DEST.tmp" "/backup/$DEST"
' <"$1" || fail "publish $2 failed"
}

# --check：只读巡检。fresh = 最近 24h 内有新 dump 且无 FAILED 标记；exit 1 = stale。
if [ "${1:-}" = "--check" ]; then
  ok=1
  if volsh 'test -f /backup/.loom-daily-dump-last-success && cat /backup/.loom-daily-dump-last-success' \
      >"$STAGE_DIR/stamp" 2>/dev/null; then
    stamp="$(tr -d '[:space:]' <"$STAGE_DIR/stamp")"
    now="$(date +%s)"
    age="$((now - stamp))"
    if [ "$age" -gt 172800 ]; then ok=0; fi
    echo "[daily-dump --check] last-success stamp age: ${age}s ($((age / 3600))h)"
  else
    echo "[daily-dump --check] last-success stamp UNREADABLE (container/daemon down?)"
    ok=0
  fi
  if volsh "ls /backup/$FAILED_MARK 2>/dev/null" >/dev/null 2>&1; then
    echo "[daily-dump --check] FAILED marker present in runtime dir"
    ok=0
  fi
  if [ -f "$INSTALL_DIR/$FAILED_MARK" ]; then
    echo "[daily-dump --check] FAILED marker present locally ($INSTALL_DIR/$FAILED_MARK)"
    ok=0
  fi
  # daily-private 覆盖汇报（只读；缺条目本身不判 stale——当天若部分发布，
  # 失败路径的 FAILED 标记/停滞戳已经是告警面）。
  volsh '
d="$(ls -d /backup/daily-private/*/ 2>/dev/null | sed "s:/\$::;s:.*/::" | sort | tail -n1)"
if [ -z "$d" ]; then
  echo "daily-private: none yet"
elif [ ! -f "/backup/daily-private/$d/SHA256SUMS" ]; then
  echo "daily-private latest: $d — SHA256SUMS MISSING"
else
  s="/backup/daily-private/$d/SHA256SUMS"; n=0; miss=""
  grep -qE "[[:space:]]history\.db\$" "$s" && n=$((n+1)) || miss="$miss history.db"
  grep -qE "[[:space:]]storage\.tar\$" "$s" && n=$((n+1)) || miss="$miss storage.tar"
  grep -q "loom-daily-$d\.dump" "$s" && n=$((n+1)) || miss="$miss loom-daily-$d.dump"
  echo "daily-private latest: $d — SHA256SUMS covers $n/3${miss:+ (missing:$miss)}"
fi
' 2>/dev/null || echo "[daily-dump --check] daily-private unreadable (container/daemon down?)"
  if [ "$ok" -eq 1 ]; then echo "[daily-dump --check] fresh"; else echo "[daily-dump --check] stale"; fi
  exit $((ok == 1 ? 0 : 1))
fi

# 前置：本机 daemon 活着——外置盘的写/标记/巡检全走容器，daemon 死了后面全是哑弹。
if ! docker info >/dev/null 2>&1; then
  remote_mark 2>/dev/null || true
  local_mark "docker daemon not reachable"
  exit 1
fi

# 当日重跑判定：manifest 在 = 完整集已存在 → dump 不早发，改走「三段全 stage 并
# 校验后，四件先写 .rtmp 临时名、再一次 rename 提交」路径——重跑任一步失败，
# 既有完整集原样、SHA256SUMS 仍可校验。同时清掉上次重跑残留的临时名。
RETRY=0
if volsh 'test -f "/backup/$PRIV_DIR/SHA256SUMS"'; then
  RETRY=1
  volsh 'rm -f "/backup/$DUMP_NAME.rtmp" "/backup/$PRIV_DIR/history.db.rtmp" \
  "/backup/$PRIV_DIR/storage.tar.rtmp" "/backup/$PRIV_DIR/SHA256SUMS.rtmp"' \
    2>/dev/null || true
fi

# ── 段 1：pg_dump 在 NAS 跑（exec channel 里远端 docker exec），stdout 落本地 staging。
run_remote pg_dump "$PG_ERR" \
  "${NAS_SSH[@]}" "docker exec $CONTAINER pg_dump -Fc -U $DB_USER $DB_NAME" \
  </dev/null >"$STAGE_DUMP"

SIZE="$(stat -f%z "$STAGE_DUMP")"
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  fail "dump too small ($SIZE bytes < $MIN_BYTES) — refusing to keep"
fi
# 字节地板之上换真校验：pg_restore -l 读 custom-format 归档 TOC，截断/损坏直接
# 非零；输出必须带归档头与至少一条 TOC 条目，否则不算可恢复的 dump。
if ! docker run --rm -i "$WRITE_IMAGE" pg_restore -l <"$STAGE_DUMP" >"$STAGE_DIR/toc" 2>/dev/null; then
  fail "pg_restore -l rejected dump — not a valid archive"
fi
if ! grep -q 'TOC Entries:' "$STAGE_DIR/toc" ||
   ! grep -qE '^[0-9]+; [0-9]+ [0-9]+' "$STAGE_DIR/toc"; then
  fail "dump TOC has no entries — refusing to keep"
fi
DUMP_SHA="$(shasum -a 256 "$STAGE_DUMP" | cut -d' ' -f1)"

# dump 早发只在当日首次：重跑（RETRY=1）按住到三段全过才提交，否则一次失败的
# 重跑会把完整集里 manifest 引用的 dump 覆盖掉，整套作废。
if [ "$RETRY" = 0 ]; then
  DUMP_NAME="$DUMP_NAME" SIZE="$SIZE" SHA="$DUMP_SHA" TS="$(date '+%F %T')" \
  volsh '
cat > "/backup/$DUMP_NAME.tmp" &&
chmod go-rwx "/backup/$DUMP_NAME.tmp" &&
mv "/backup/$DUMP_NAME.tmp" "/backup/$DUMP_NAME" &&
printf "%s OK: %s/%s (%s bytes, sha256 %s)\n" "$TS" "$RUNTIME_DIR" "$DUMP_NAME" "$SIZE" "$SHA" >> /backup/loom-daily-dump.log
' <"$STAGE_DUMP" || fail "publish dump to runtime dir failed (docker run write)"
else
  vlog "complete set for today exists — holding dump until all parts staged" 2>/dev/null
fi

# ── 段 2：mem0 history.db。源文件不存在=mem0 还没写过（全新库正常态），远端往
# stderr 打哨兵行、仍 0 退出；本侧按哨兵记 0 字节 history.db（0 字节本身是合法
# 空 SQLite 库），与「真失败=远端非零退出走 fail」区分开。源文件存在时本侧还要
# 求产物非空且带 SQLite 头——空文件/坏流出不算成功（重叠运行的互删也靠
# mktemp 唯一临时目录挡掉，不用固定路径）。
cat >"$STAGE_DIR/hist-remote.sh" <<'EOS'
set -u
T="$(mktemp -d /tmp/loom-hist-backup.XXXXXX)" || exit 1
cat >"$T/backup.cjs" <<'JS'
const fs = require('fs');
const SRC = '/var/lib/mem0/history.db';
if (!fs.existsSync(SRC)) {
  process.stderr.write('LOOM_HISTORY_ABSENT\n');
  process.exit(0);
}
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database(SRC, { readonly: true, fileMustExist: true });
db.backup(process.env.LOOM_BK_OUT)
  .then(() => { db.close(); })
  .catch((e) => {
    try { db.close(); } catch (_) {}
    process.stderr.write(String((e && e.message) || e) + '\n');
    process.exit(1);
  });
JS
if LOOM_BK_OUT="$T/history.db" node "$T/backup.cjs"; then
  if [ -f "$T/history.db" ]; then
    cat "$T/history.db"
    rc=$?
  else
    rc=0
  fi
else
  rc=1
fi
rm -rf "$T"
exit "$rc"
EOS

run_remote history_db "$HIST_ERR" \
  "${NAS_SSH[@]}" "docker exec -i $WORKER_CONTAINER sh -s" \
  <"$STAGE_DIR/hist-remote.sh" >"$STAGE_HIST"
if grep -q 'LOOM_HISTORY_ABSENT' "$HIST_ERR"; then
  : >"$STAGE_HIST"
  vlog "mem0 history.db absent on worker (fresh db) — recorded as empty file" 2>/dev/null
elif ! head -c 15 "$STAGE_HIST" | grep -q 'SQLite format 3'; then
  fail "mem0 history.db capture produced empty/non-SQLite output"
fi

# ── 段 3：storage /data 活拷贝 tar（append-mostly；GNU tar 的「file changed as we
# read it」告警给 rc 1——append-mostly 存储常态，仅当 stderr 确实是该告警时放行；
# busybox tar 的一切错误也报 rc 1，不能笼统放过 rc≤1）。
run_remote storage_tar "$STOR_ERR" \
  "${NAS_SSH[@]}" "docker exec $STORAGE_CONTAINER sh -c 'E=\$(mktemp /tmp/loom-tar-err.XXXXXX) || exit 1; tar -C /data -cf - . 2>\"\$E\"; rc=\$?; if [ \$rc -eq 1 ] && grep -q \"changed as we read\" \"\$E\"; then rc=0; fi; cat \"\$E\" >&2; rm -f \"\$E\"; exit \$rc'" \
  </dev/null >"$STAGE_TAR"

# tar 里零文件条目（只含目录项）= /data 空或挂错——不看字节数，看条目数；失败留痕走 fail。
if ! tar -tf "$STAGE_TAR" >"$STAGE_DIR/tar.list" 2>/dev/null; then
  fail "storage tar unreadable (tar -tf failed)"
fi
if ! grep -q '[^/]$' "$STAGE_DIR/tar.list"; then
  fail "storage tar lists zero files — /data empty or wrong mount"
fi

# ── 发布 daily-private/<date>/：目录与文件一律 owner-only（chmod go-rwx）；
# SHA256SUMS 盖当天三件，dump 条目用相对路径指向上两级
# （校验：cd daily-private/<d> && shasum -c SHA256SUMS）。
HIST_SIZE="$(stat -f%z "$STAGE_HIST")"
HIST_SHA="$(shasum -a 256 "$STAGE_HIST" | cut -d' ' -f1)"
STOR_SIZE="$(stat -f%z "$STAGE_TAR")"
STOR_SHA="$(shasum -a 256 "$STAGE_TAR" | cut -d' ' -f1)"
{
  printf '%s  history.db\n' "$HIST_SHA"
  printf '%s  storage.tar\n' "$STOR_SHA"
  printf '%s  ../../%s\n' "$DUMP_SHA" "$DUMP_NAME"
} >"$STAGE_SUMS"

if [ "$RETRY" = 0 ]; then
  PRIV_DIR="$PRIV_DIR" volsh '
mkdir -p "/backup/$PRIV_DIR" &&
chmod go-rwx "/backup/$PRIV_DIR" &&
chmod go-rwx "$(dirname "/backup/$PRIV_DIR")"
' || fail "prepare daily-private dir failed"

  publish_file "$STAGE_HIST" "$PRIV_DIR/history.db"
  publish_file "$STAGE_TAR" "$PRIV_DIR/storage.tar"
  publish_file "$STAGE_SUMS" "$PRIV_DIR/SHA256SUMS"
else
  # 重跑提交：四件各自流到 .rtmp 临时名（慢、可失败的部分分段做），再一次 volsh
  # 统一 rename、manifest 最后落——rename 批之前的任何失败都动不到既有完整集。
  stage_rtmp() {
    DEST="$2" volsh '
cat > "/backup/$DEST" && chmod go-rwx "/backup/$DEST"
' <"$1" || fail "retry stage $2 to volume failed"
  }
  stage_rtmp "$STAGE_DUMP" "$DUMP_NAME.rtmp"
  stage_rtmp "$STAGE_HIST" "$PRIV_DIR/history.db.rtmp"
  stage_rtmp "$STAGE_TAR" "$PRIV_DIR/storage.tar.rtmp"
  stage_rtmp "$STAGE_SUMS" "$PRIV_DIR/SHA256SUMS.rtmp"

  DUMP_NAME="$DUMP_NAME" PRIV_DIR="$PRIV_DIR" SIZE="$SIZE" SHA="$DUMP_SHA" \
  TS="$(date '+%F %T')" \
  volsh '
mv "/backup/$DUMP_NAME.rtmp" "/backup/$DUMP_NAME" &&
mv "/backup/$PRIV_DIR/history.db.rtmp" "/backup/$PRIV_DIR/history.db" &&
mv "/backup/$PRIV_DIR/storage.tar.rtmp" "/backup/$PRIV_DIR/storage.tar" &&
mv "/backup/$PRIV_DIR/SHA256SUMS.rtmp" "/backup/$PRIV_DIR/SHA256SUMS" &&
printf "%s OK: %s/%s (%s bytes, sha256 %s)\n" "$TS" "$RUNTIME_DIR" "$DUMP_NAME" "$SIZE" "$SHA" >> /backup/loom-daily-dump.log
' || fail "retry commit (rename) failed"
fi
vlog "OK: $PRIV_DIR history.db ($HIST_SIZE bytes, sha256 $HIST_SHA) storage.tar ($STOR_SIZE bytes, sha256 $STOR_SHA)" \
  2>/dev/null

# 成功戳 + 清 FAILED 标记 + 保留策略：三段全发布完才盖戳，戳滞后=今天不完整。
# 保留窗口对 dump 与 daily-private 相同（最新 KEEP_DAILY 份 + 每月 1 号），但两条
# 链不能各数各的：先清目录，再清 dump，且「同日 daily-private 目录还在」的 dump
# 一律不删——目录在则 SHA256SUMS 可校验；失败日只有 dump 没有目录，照窗口清理。
FAILED_MARK="$FAILED_MARK" KEEP="$KEEP_DAILY" \
TS="$(date '+%F %T')" STAMP="$(date +%s)" \
volsh '
rm -f "/backup/$FAILED_MARK" &&
printf "%s" "$STAMP" > /backup/.loom-daily-dump-last-success &&
cd /backup &&
if [ -d daily-private ]; then
  count=0
  ls -d daily-private/*/ 2>/dev/null | sed "s:/\$::;s:.*/::" | sort -r | while read -r d; do
    count=$((count + 1))
    [ "$count" -le "$KEEP" ] && continue
    dom="$(echo "$d" | cut -c7-8)" # YYYYMMDD → DD
    [ "$dom" = "01" ] && continue
    rm -rf "daily-private/$d"
    printf "%s pruned: daily-private/%s\n" "$TS" "$d" >> /backup/loom-daily-dump.log
  done
fi
count=0 &&
ls -t loom-daily-*.dump 2>/dev/null | while read -r f; do
  count=$((count + 1))
  [ "$count" -le "$KEEP" ] && continue
  dom="$(echo "$f" | cut -c18-19)" # loom-daily-YYYYMMDD.dump → DD
  [ "$dom" = "01" ] && continue
  d="${f#loom-daily-}"; d="${d%.dump}"
  [ -d "daily-private/$d" ] && continue
  rm -f "$f"
  printf "%s pruned: %s\n" "$TS" "$f" >> /backup/loom-daily-dump.log
done
' || fail "finalize (stamp/retention) failed"
