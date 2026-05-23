#!/usr/bin/env bash
# PostToolUse Bash hook — branch-divergence echo after git fetch / pull.
#
# Triggers on any `git ... fetch` / `git ... pull` invocation (handles global
# opts like `git -C <repo> fetch`, `git --no-pager pull`, etc.). When the
# current branch's upstream is ahead/behind, echoes the delta + upstream-only
# authors to stderr so the agent sees it in context.
#
# Codex review 2026-05-23 on PR #95 (settings.json:42 P2): previous inline
# version only matched literal `git fetch` / `git pull` substrings, missing
# common global-opt forms. Extracted to script + token-aware grep for
# maintainability.
#
# Always exit 0 (informational, not blocking).

set -u

cmd=$(jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

# Token-aware match: `git ... fetch` or `git ... pull` where ... can include
# any global opt sequence not crossing a shell operator. We don't fully parse
# global opts here — just verify both `git` and the subcommand token appear
# before the first shell operator, and the subcommand is one of fetch/pull.
#
# Strip from first shell operator onward, then check.
first_segment="${cmd%%|*}"
first_segment="${first_segment%%&&*}"
first_segment="${first_segment%%;*}"

if ! echo "$first_segment" | grep -qE '\bgit\b'; then exit 0; fi
if ! echo "$first_segment" | grep -qE '\b(fetch|pull)\b'; then exit 0; fi

# At this point cmd has both `git` and `fetch|pull` in the first command
# segment. Resolve cwd from `git -C <path>` or `--git-dir=<path>` if present;
# fall back to process cwd. Used so the divergence check runs against the
# actual target repo, not the hook process's cwd.
cwd_override=""
if [[ "$first_segment" =~ git[[:space:]]+(-c[[:space:]]+[^[:space:]]+[[:space:]]+)*-C[[:space:]]+([^[:space:]]+) ]]; then
  cwd_override="${BASH_REMATCH[2]}"
elif [[ "$first_segment" =~ --git-dir=([^[:space:]]+) ]]; then
  cwd_override="${BASH_REMATCH[1]}"
elif [[ "$first_segment" =~ --git-dir[[:space:]]+([^[:space:]]+) ]]; then
  cwd_override="${BASH_REMATCH[1]}"
fi

git_args=()
if [ -n "$cwd_override" ]; then git_args+=(-C "$cwd_override"); fi

br=$(git "${git_args[@]}" branch --show-current 2>/dev/null || echo "")
up=$(git "${git_args[@]}" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo "")
if [ -z "$up" ]; then exit 0; fi

ah=$(git "${git_args[@]}" rev-list --count "$up..HEAD" 2>/dev/null || echo 0)
be=$(git "${git_args[@]}" rev-list --count "HEAD..$up" 2>/dev/null || echo 0)

if [ "${ah:-0}" -eq 0 ] && [ "${be:-0}" -eq 0 ]; then exit 0; fi

echo "branch-delta: $br vs $up — ahead $ah / behind $be" >&2
if [ "${be:-0}" -gt 0 ]; then
  authors=$(git "${git_args[@]}" log --format='%an' "HEAD..$up" 2>/dev/null | sort -u | tr '\n' ',' | sed 's/,$//')
  echo "  upstream authors: $authors" >&2
fi

exit 0
