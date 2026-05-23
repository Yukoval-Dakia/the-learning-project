#!/usr/bin/env bash
# Stop hook — Linear closeout reminder.
#
# Fires when Claude is about to finalize a response. Detects whether this
# session likely touched code/docs (proxy: any commit in last 30 min, OR
# any uncommitted working-tree changes). If yes, echoes a Linear gate
# reminder to the agent context.
#
# Per docs/agents/issue-tracker.md "Closeout issue capture gate", the agent
# must say which Linear issues were created/updated OR say "No Linear issue
# needed" with a one-sentence reason. This hook is the harness-side nudge —
# self-discipline is unreliable across long sessions.
#
# Output goes to stderr so Claude sees it as additional context. Exit always
# 0 — this is a reminder, not a block.

set -u

cd "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || exit 0

# Signal 1: commits in the last 30 minutes on the current branch
recent_commits=$(git log --since='30 minutes ago' --oneline 2>/dev/null | wc -l | tr -d ' ')

# Signal 2: uncommitted changes
dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

# No activity → no reminder
if [ "${recent_commits:-0}" -eq 0 ] && [ "${dirty:-0}" -eq 0 ]; then
  exit 0
fi

branch=$(git branch --show-current 2>/dev/null || echo "?")

cat >&2 <<EOF
linear-gate: $recent_commits recent commit(s) + $dirty uncommitted file(s) on branch \`$branch\`.

Before stopping, verify the Linear closeout gate per docs/agents/issue-tracker.md:
  - did the work create new follow-ups? → save_issue
  - did it complete in-flight YUK-NN issues? → integration usually handles via
    commit \`Closes YUK-NN\`, but verify state for issues left In Progress
  - if nothing needed, your final response should say "No Linear issue needed"
    with a one-sentence reason
EOF

exit 0
