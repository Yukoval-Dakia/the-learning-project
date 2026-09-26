#!/usr/bin/env bash
# ship-tick.sh — one tick of the ship engine (idempotent state machine).
# Autonomous loop: babysit in-flight PR lanes -> claim next ready-for-agent
# issue -> drive it to a PR. Everything cross-tick lives in .omc/ship-engine/.
# Usage: scripts/ship-tick.sh [--tick-only] [--dry-run]
set -u
REPO="/Volumes/YukovalSBak/yukoval-projects/the-learning-project"
cd "$REPO" || exit 1

ROOT=".omc/ship-engine"
STATE="$ROOT/state.json"
WORKLOG=".remember/worklog-ship-engine.tsv"
LOCKDIR="$ROOT/tick.lock.d"
LOGDIR="$ROOT/logs"
mkdir -p "$ROOT" "$LOGDIR" .remember

TEAM="YUK"
READY_LABEL="ready-for-agent"
POLL_SECONDS="${SHIP_POLL_SECONDS:-900}"
MAX_LANES=1                 # single dev stack :5173/:8787 — one in-flight lane at a time
MAX_CLAIMS_PER_DAY="${SHIP_MAX_CLAIMS_PER_DAY:-4}"
MAX_FIX_ATTEMPTS=2          # same-cause red CI: 2 fixes then blocked
MERGE_METHOD="--squash"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# ---------- helpers ----------
log()  { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOGDIR/engine.log"; }
wlog() { printf '%s\t%s\t%s\t%s\n' "$(date -u '+%FT%TZ')" "$1" "$2" "$3" >> "$WORKLOG"; }
jget() { jq -r "$@" "$STATE" 2>/dev/null; }
jset() { local tmp; tmp=$(mktemp); jq "$1" "$STATE" > "$tmp" && mv "$tmp" "$STATE"; }

[ -f "$STATE" ] || cat > "$STATE" <<'JSON'
{ "version": 1, "lanes": [], "claims": [] }
JSON

mkdir "$LOCKDIR" 2>/dev/null || { log "tick already running, exit"; exit 0; }
trap 'rmdir "$LOCKDIR"' EXIT

today() { date '+%F'; }
claims_today() { jget --arg d "$(today)" '[.claims[] | select(.date==$d)] | length'; }
lane_count()   { jget '[.lanes[] | select(.state!="merged" and .state!="abandoned" and .state!="blocked")] | length'; }

# opencode run, capture session id + tail of output
# $1=session-to-resume-or-empty  $2=prompt  $3=logfile
ocr() {
  local sess="$1" prompt="$2" outf="$3" sid="" rc=0
  if [ -n "$sess" ]; then
    opencode run --auto --session "$sess" --format json -- "$prompt" > "$outf" 2>&1 || rc=$?
  else
    opencode run --auto --format json --title "ship-tick $(date +%H%M)" -- "$prompt" > "$outf" 2>&1 || rc=$?
  fi
  sid=$(grep -oE 'ses_[A-Za-z0-9]+' "$outf" | head -1 || true)
  [ -z "$sid" ] && sid="$sess"
  printf '%s|%s' "$rc" "$sid"
}

# ---------- prompts (single source of truth for lane behavior) ----------
COMMON="仓库根 ${REPO}。规则：AGENTS.md + .claude/skills/ship-mode + .claude/skills/verify-app + .claude/skills/worklog 已生效，照做。
硬约束：所有 git/pnpm 操作只能在你的 worktree 内；不许 commit 到 main；不许 force push / branch -D / worktree remove --force；每条完成声明同句带证据（命令输出/file:line/SHA/artifact 路径）；wrong-surface / INCONCLUSIVE 不算过。Linear 操作用 tools.linear。*（MCP）；gh 用于 GitHub。
收尾必须输出一行 LANE_STATUS: <implemented|blocked> 和一行 SESSION_ID: <本会话 ses_ id>。"

PROMPT_CLAIM() { cat <<EOF
$COMMON
你是 ship-engine 的一条实现 lane，负责本票端到端闭环到 PR。

步骤：
1. tools.linear.get_issue 读 $1；若 blockedBy 有未完成票、或已有人认领/已有 PR → 输出 LANE_STATUS: blocked（原因），停。
2. tools.linear.save_comment 留「ship-engine 认领，lane 启动」；tools.linear.save_issue 置 In Progress。
3. 建 worktree：git worktree add .claude/worktrees/ship-$2 -b ship/$2 origin/main（在仓库根执行；之后的命令一律 cd 进该 worktree）。
4. 在 worktree 内按 ship-mode 匹配 playbook（bug→bug-fix 等）实施。UI/API 验证用 verify-app（:5173/:8787/x-internal-token，dev 栈由你起，跑完清理你起的进程）。修 schema/route/job 走 capabilities manifest；改 route 同步 postman + pnpm gen:postman。
5. scoped gate：pnpm typecheck / lint / 匹配范围测试 / build。证据写 worklog（.remember/worklog-$2.tsv，worktree 内相对路径不可用时写主 repo 绝对路径）。
6. 提交带 YUK-$3 引用；push 只推 ship/$2；gh pr create（非 draft），title 含 YUK-$3，body 含现象/根因/证据/before-after 输出；追加一行 Closes YUK-$3。
7. 回 Linear save_comment 贴 PR 链接 + 证据摘要。
EOF
}

PROMPT_FIXCI() { cat <<EOF
$COMMON
你的 lane $1（worktree .claude/worktrees/ship-$1，branch ship/$1）PR #$2 的 exact-head CI Gate 红了。
gh 拉失败 check 日志定位；worktree 内修；重跑 scoped gate；commit+push ship/$1；输出 LANE_STATUS + 修复说明。
EOF
}

PROMPT_REVIEW() { cat <<EOF
$COMMON
裁决 PR #$1（branch $2）的 review/bot threads。gh api 拉 reviewThreads + comments；只处理已验证的 P0/P1（security/data-loss/correctness/release-blocker）→ 在 worktree .claude/worktrees/ship-$2 内修+push；P2/nit 回复 skip rationale 并 resolve。不声称已修复未修的东西。输出 VERDICT: <clear|blocked> + 证据。
EOF
}

# ---------- phase A: babysit in-flight lanes ----------
log "=== tick start ==="
nlanes=$(jq '.lanes|length' "$STATE")
for i in $(seq 0 $((nlanes-1))); do
  st=$(jget ".lanes[$i].state"); id=$(jget -r ".lanes[$i].issue"); br=$(jget -r ".lanes[$i].branch")
  pr=$(jget -r ".lanes[$i].pr // empty"); sess=$(jget -r ".lanes[$i].session // empty"); att=$(jget ".lanes[$i].fix_attempts // 0")
  [ "$st" = "merged" ] || [ "$st" = "blocked" ] || [ "$st" = "abandoned" ] && continue

  if [ "$st" = "implementing" ]; then
    # lane session drives itself; tick only reaps a PR number once it appears
    newpr=$(gh pr list --head "$br" --json number --jq '.[0].number' 2>/dev/null || true)
    if [ -n "$newpr" ]; then jset ".lanes[$i].pr=$newpr | .lanes[$i].state=\"pr_open\" | .lanes[$i].ticks=0"; wlog "$id" "pr opened #$newpr" "$br"; log "$id pr=$newpr"; continue; fi
    ticks=$(jget ".lanes[$i].ticks // 0")
    if [ "$ticks" -ge 24 ]; then
      jset ".lanes[$i].state=\"blocked\""; wlog "$id" "blocked: stale implementing (no PR after $ticks ticks)" "$br"; log "$id BLOCKED stale"; continue
    fi
    jset ".lanes[$i].ticks=$((ticks+1))"; continue
  fi

  [ -z "$pr" ] && continue
  prj=$(gh pr view "$pr" --json state,isDraft,statusCheckRollup --jq '{s:.state,d:.isDraft,fail:[.statusCheckRollup[]|select(.conclusion=="FAILURE" or .status=="FAILURE")]|length,pend:[.statusCheckRollup[]|select(.status!="COMPLETED" and .conclusion==null)]|length}' 2>/dev/null || echo '{}')
  pstate=$(echo "$prj" | jq -r '.s // "?"')
  [ "$pstate" = "MERGED" ] && { jset ".lanes[$i].state=\"merged\""; wlog "$id" "merged" "pr#$pr"; log "$id merged"; git worktree remove ".claude/worktrees/ship-$br" 2>/dev/null; git branch -d "ship/$br" 2>/dev/null; continue; }
  [ "$pstate" = "CLOSED" ] && { jset ".lanes[$i].state=\"abandoned\""; wlog "$id" "pr closed unmerged" "pr#$pr"; continue; }
  echo "$prj" | jq -e '.d==false' >/dev/null || { log "$id draft pr, skip merge-eval"; continue; }

  fails=$(echo "$prj" | jq -r '.fail'); pends=$(echo "$prj" | jq -r '.pend')
  if [ "$fails" -gt 0 ]; then
    if [ "$att" -ge "$MAX_FIX_ATTEMPTS" ]; then
      jset ".lanes[$i].state=\"blocked\""; wlog "$id" "blocked: CI red after $att fixes" "pr#$pr"; log "$id BLOCKED ci"; continue
    fi
    [ "$DRY_RUN" = 1 ] && { log "[dry] would fix CI on pr#$pr"; continue; }
    res=$(ocr "$sess" "$(PROMPT_FIXCI "$br" "$pr")" "$LOGDIR/fix-$br-$(date +%s).log"); sid=${res##*|}
    jset ".lanes[$i].fix_attempts=$((att+1)) | .lanes[$i].session=\"$sid\""; wlog "$id" "ci fix attempt $((att+1))" "session $sid"
    continue
  fi
  [ "$pends" -gt 0 ] && { log "$id ci pending"; continue; }

  # CI green -> adjudicate review threads, then merge per repo policy
  threads=$(gh api graphql -f query='query($n:Int!){repository(owner:"{owner}",name:"{repo}"){pullRequest(number:$n){reviewThreads(first:50){nodes{isResolved isOutdated}}}}}' -F n="$pr" --jq '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false and .isOutdated==false)]|length' 2>/dev/null || echo "0")
  if [ "$threads" != "0" ]; then
    [ "$DRY_RUN" = 1 ] && { log "[dry] would adjudicate $threads threads pr#$pr"; continue; }
    res=$(ocr "" "$(PROMPT_REVIEW "$pr" "$br")" "$LOGDIR/review-$br-$(date +%s).log"); sid=${res##*|}
    verdict=$(grep -oE 'VERDICT: (clear|blocked)' "$LOGDIR/review-$br"-*.log | tail -1 | cut -d' ' -f2)
    [ "$verdict" != "clear" ] && { wlog "$id" "review adjudication unresolved" "pr#$pr"; continue; }
  fi
  [ "$DRY_RUN" = 1 ] && { log "[dry] would merge pr#$pr"; continue; }
  gh pr merge "$pr" $MERGE_METHOD --delete-branch 2>>"$LOGDIR/engine.log" \
    && { jset ".lanes[$i].state=\"merged\""; wlog "$id" "merged" "pr#$pr"; log "$id merged"; git checkout main -q && git pull --ff-only origin main -q; git worktree remove ".claude/worktrees/ship-$br" 2>/dev/null; git branch -d "ship/$br" 2>/dev/null; } \
    || { wlog "$id" "merge command failed" "pr#$pr"; log "$id merge failed"; }
done

# ---------- phase B: claim next issue ----------
[ "$(lane_count)" -ge "$MAX_LANES" ] && { log "lane full, no claim"; exit 0; }
[ "$(claims_today)" -ge "$MAX_CLAIMS_PER_DAY" ] && { log "daily claim budget exhausted"; exit 0; }
[ "$DRY_RUN" = 1 ] && { log "[dry] would attempt claim"; exit 0; }

# pick a candidate in-session (needs Linear MCP)
res=$(ocr "" "$(cat <<EOF
$COMMON
从 Linear 找下一条可做票：tools.linear.list_issues team=$TEAM label=$READY_LABEL（非 terminated 状态），按 priority 升序、createdAt 升序取第一张；get_issue 确认 blockedBy 无未完成且无人认领、无已开 PR。输出 CANDIDATE: YUK-NNN 一行；没有合格的输出 CANDIDATE: none。
EOF
)" "$LOGDIR/claim-pick-$(date +%s).log")
pick=$(grep -oE 'CANDIDATE: (YUK-[0-9]+|none)' "$LOGDIR/claim-pick"-*.log | tail -1 | awk '{print $2}')
[ -z "$pick" ] || [ "$pick" = "none" ] && { log "no eligible issue"; exit 0; }

slug=$(echo "$pick" | tr 'A-Z' 'a-z')
br="yuk-${slug#yuk-}"
wlog "$pick" "claim" "branch ship/$br"; log "claiming $pick"
res=$(ocr "" "$(PROMPT_CLAIM "$pick" "$br" "${pick#YUK-}")" "$LOGDIR/impl-$br-$(date +%s).log")
rc=${res%%|*}; sid=${res##*|}
lane_state="implementing"
grep -q 'LANE_STATUS: blocked' "$LOGDIR/impl-$br"-*.log 2>/dev/null && lane_state="blocked"
jset --arg id "$pick" --arg br "$br" --arg sess "$sid" --arg st "$lane_state" --argjson att 0 \
  '.lanes += [{issue:$id, branch:$br, session:$sess, state:$st, pr:null, fix_attempts:$att, ticks:0}]'
jset --arg d "$(today)" --arg id "$pick" '.claims += [{date:$d, issue:$id}]'
wlog "$pick" "lane dispatched" "state=$lane_state session=$sid rc=$rc"
log "=== tick end ==="
