#!/usr/bin/env bash
# 只读巡检：按分支前缀把 PR 归到线，输出每条线的状态与要执行的 ACTION。
# 用法：patrol.sh [槽位数=4]
set -euo pipefail

SLOTS="${1:-4}"
FIELDS='number,headRefName,isDraft,mergeStateStatus,updatedAt,statusCheckRollup'

open=$(gh pr list --state open --limit 100 --json "$FIELDS")
merged=$(gh pr list --state merged --limit 200 --json number,headRefName,mergedAt)

out=$(jq -rn --argjson open "$open" --argjson merged "$merged" --argjson slots "$SLOTS" '
  def line: if test("^ui/") then "ui" elif test("^arch/") then "arch" elif test("^feat/") then "feat" else "other" end;
  def ts: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
  def mins($t): ((now - $t) / 60 | floor);

  ($open | map(select(.headRefName | test("^dependabot/") | not) | . + {
    line: (.headRefName | line),
    pushed: ([.statusCheckRollup[]? | .startedAt // empty | select(. != "0001-01-01T00:00:00Z") | ts] | max // (.updatedAt | ts)),
    checks: [.statusCheckRollup[]? | (.conclusion // .state // "PENDING")],
    checked: ([.statusCheckRollup[]? | .completedAt // empty | select(. != "0001-01-01T00:00:00Z") | ts] | max // null)
  } | . + {
    green: ((.checks | length) > 0 and (.checks | all(. == "SUCCESS" or . == "NEUTRAL" or . == "SKIPPED")) and .mergeStateStatus == "CLEAN"),
    red: (.checks | any(. == "FAILURE" or . == "ERROR" or . == "TIMED_OUT"))
  })) as $prs
  | ($merged | map(. + {line: (.headRefName | line), at: (.mergedAt | ts)})) as $done
  | ["ui", "arch", "feat"][] as $l
  | ($prs | map(select(.line == $l))) as $mine
  | ($mine | map(select(mins(.pushed) <= 45)) | length) as $active
  | ($done | map(select(.line == $l))) as $mdone
  | ($mdone | map(select(mins(.at) <= 60)) | length) as $hour
  | ($mdone | map(.at) | max // null) as $last
  | "LINE \($l) open=\($mine | length) active=\($active)/\($slots) merged_60m=\($hour) since_merge=\(if $last then "\(mins($last))m" else "none" end)",
    ($mine[] | select(.green and .checked != null and mins(.checked) >= 15)
      | "ACTION \($l) #\(.number) 全绿已 \(mins(.checked)) 分钟\(if .isDraft then "，仍是 draft：转 ready 并合并" else "：现在合并" end)"),
    ($mine[] | select(.red and mins(.pushed) >= 30)
      | "ACTION \($l) #\(.number) CI 红且 \(mins(.pushed)) 分钟没有新提交：交回写手修"),
    ($mine[] | select(.mergeStateStatus == "DIRTY")
      | "ACTION \($l) #\(.number) 与 main 冲突：追 main"),
    (if $active < $slots then "ACTION \($l) 只有 \($active)/\($slots) 个槽在动：现在派 \($slots - $active) 个写手" else empty end),
    (if $hour == 0 then "ACTION \($l) 过去 60 分钟没有合并：报出最接近合并的 PR 和它差的那一步" else empty end)
')
echo "$out"

other=$(jq '[.[] | select(.headRefName | test("^(ui|arch|feat|dependabot)/") | not)] | length' <<<"$open")
echo "UNASSIGNED open=$other（分支没有 ui/ arch/ feat/ 前缀，不计入任何线）"

if [ "${PATROL_QUEUE:-0}" = "1" ]; then
  for l in ui arch feat; do
    msg=$(echo "$out" | { rg "^LINE $l|^ACTION $l" || true; })
    [ -n "$msg" ] || continue
    if codex queue --thread "lead-$l" --message "$msg" --resume >/dev/null 2>&1; then
      echo "QUEUED lead-$l"
    else
      echo "QUEUE_FAILED lead-$l（线程名不存在或 daemon 不在线）"
    fi
  done
fi
