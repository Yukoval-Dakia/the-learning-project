#!/usr/bin/env bash
# SessionStart hook: 提示 agent 代码检索工具分工（ykv-code-index + LSP/grep）。
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Code search tools: [1] ykv-code-index — semantic cross-file discovery; use search_code first for unfamiliar areas or conceptual questions, and index_status only to diagnose index health. [2] LSP or grep — known symbols, references, literals, regexes and file names."}}
JSON
