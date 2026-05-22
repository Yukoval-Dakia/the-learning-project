#!/usr/bin/env bash
# SessionStart hook: 提示 agent 立即把 auggie MCP 工具 schema 拉进主工具列表。
# auggie 是用户级 stdio MCP（~/.claude.json 顶层 mcpServers，命令 `auggie --mcp`），默认进 deferred，要 ToolSearch 才能调。
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"auggie MCP server is available for codebase search. At session start, immediately call ToolSearch with query=\"select:mcp__auggie__codebase-retrieval\" to load its schema. Prefer it over ad-hoc grep when doing semantic code search across the repo."}}
JSON
