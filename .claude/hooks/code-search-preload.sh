#!/usr/bin/env bash
# SessionStart hook: 提示 agent 代码检索工具分工（serena + ykv-code-index）。
# 两者默认 deferred，要 ToolSearch 才能调。
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Code search tools: [1] serena — symbol-precise lookup (find_symbol / find_referencing_symbols / get_symbols_overview); use for known symbols, reference enumeration, and file structure; call initial_instructions once before first use. [2] ykv-code-index — semantic cross-file discovery; use search_code first for unfamiliar areas or conceptual questions, and index_status only to diagnose index health. Prefer these over ad-hoc grep for discovery; grep/glob remain appropriate for exact literals, regexes, known symbols, and file names."}}
JSON
