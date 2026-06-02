// YUK-198 — Tavily remote MCP wiring for the product Claude Agent SDK.
//
// Tavily ships a hosted (remote) MCP server. The Agent SDK's
// `Options['mcpServers']` accepts a remote `McpHttpServerConfig`
// ({ type:'http', url, headers?, tools?, alwaysLoad? }), so we point the SDK at
// `https://mcp.tavily.com/mcp/` and authenticate via the `tavilyApiKey` query
// param (Tavily's documented hosted-MCP auth form).
//
// The API key is ONLY ever read from `process.env.TAVILY_API_KEY` — never
// hardcoded, never logged. When the env var is absent/blank this module is a
// graceful no-op (`buildTavilyMcpServer()` returns null) so the surface keeps
// working offline / unconfigured.
//
// Scope: we only expose `search` + `extract` (web grounding). `crawl` / `map` /
// `research` are deliberately left off — too heavy for an interactive Copilot
// turn. MCP tools are named `mcp__<serverName>__<toolName>` in SDK
// allowedTools; the serverName here is `tavily`, and the upstream tool names
// are underscored (`tavily_search`, `tavily_extract` — confirmed via the
// Tavily MCP tool-definition / input-schema docs, NOT the hyphenated prose
// spelling in the README narrative).

import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/** MCP server name this helper registers under (drives the mcp__<name>__* prefix). */
export const TAVILY_MCP_SERVER_NAME = 'tavily';

/** Hosted Tavily MCP endpoint (key is appended as a query param at build time). */
const TAVILY_MCP_BASE_URL = 'https://mcp.tavily.com/mcp/';

/**
 * Upstream Tavily MCP tool names we scope to. Web grounding only:
 * `tavily_search` (real-time web search) + `tavily_extract` (URL → content).
 * `tavily_crawl` / `tavily_map` / `tavily_research` are intentionally excluded.
 */
export const TAVILY_SCOPED_TOOL_NAMES = ['tavily_search', 'tavily_extract'] as const;

/**
 * SDK `allowedTools` entries for the scoped Tavily tools, namespaced by the
 * server name (`mcp__tavily__tavily_search`, `mcp__tavily__tavily_extract`).
 * Listed explicitly (not a `mcp__tavily` server-wide wildcard) to match how the
 * rest of the codebase enumerates exact MCP tool names and to keep the scope
 * pinned to search + extract.
 */
export const TAVILY_MCP_ALLOWED_TOOLS = TAVILY_SCOPED_TOOL_NAMES.map(
  (name) => `mcp__${TAVILY_MCP_SERVER_NAME}__${name}` as const,
);

/**
 * Build the remote Tavily MCP server config from `process.env.TAVILY_API_KEY`.
 *
 * - key present (non-blank after trim) → `{ type:'http', url }` with the key
 *   URL-encoded into the `tavilyApiKey` query param.
 * - key missing / blank → `null` (graceful no-op; caller must not register it).
 *
 * The key is read ONLY from the environment and is never logged by this module.
 */
export function buildTavilyMcpServer(): McpHttpServerConfig | null {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) return null;
  const url = `${TAVILY_MCP_BASE_URL}?tavilyApiKey=${encodeURIComponent(key)}`;
  return { type: 'http', url } satisfies McpHttpServerConfig;
}
