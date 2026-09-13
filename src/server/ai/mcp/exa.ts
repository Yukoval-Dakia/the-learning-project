// Exa remote MCP wiring for the product Claude Agent SDK（Tavily → Exa 换装，
// 2026-09-13 owner 拍板；挂载形状照 YUK-198 Tavily 先例）。
//
// Exa ships a hosted (remote) MCP server. The Agent SDK's
// `Options['mcpServers']` accepts a remote `McpHttpServerConfig`
// ({ type:'http', url, headers?, tools?, alwaysLoad? }), so we point the SDK at
// `https://mcp.exa.ai/mcp` and authenticate via the `x-api-key` header — Exa's
// highest-priority documented auth form（query param `exaApiKey` 也受支持，但
// header 让 key 不进 URL/日志；live-probed 2026-09-13: streamable-HTTP
// `initialize` + `tools/list` 双通，server v3.2.1）。
//
// The API key is ONLY ever read from `process.env.EXA_API_KEY` — never
// hardcoded, never logged. When the env var is absent/blank this module is a
// graceful no-op (`buildExaMcpServer()` returns null) so the surface keeps
// working offline / unconfigured.
//
// Scope: the hosted server exposes exactly two tools (live `tools/list` probe):
// `web_search_exa`（web 搜索；required: query + objective，可选 numResults）与
// `web_fetch_exa`（URL → clean markdown；required: urls[]，可选 maxCharacters）——
// 1:1 对应旧 tavily_search / tavily_extract。MCP tools are named
// `mcp__<serverName>__<toolName>` in SDK allowedTools; the serverName here is
// `exa`。

import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/** MCP server name this helper registers under (drives the mcp__<name>__* prefix). */
export const EXA_MCP_SERVER_NAME = 'exa';

/** Hosted Exa MCP endpoint (key is appended as a query param at build time). */
const EXA_MCP_BASE_URL = 'https://mcp.exa.ai/mcp';

/**
 * Upstream Exa MCP tool names we scope to — the hosted server's complete tool
 * surface (live-probed 2026-09-13): `web_search_exa` (real-time web search) +
 * `web_fetch_exa` (URLs → content markdown).
 */
export const EXA_SCOPED_TOOL_NAMES = ['web_search_exa', 'web_fetch_exa'] as const;

/**
 * SDK `allowedTools` entries for the scoped Exa tools, namespaced by the
 * server name (`mcp__exa__web_search_exa`, `mcp__exa__web_fetch_exa`).
 * Listed explicitly (not a `mcp__exa` server-wide wildcard) to match how the
 * rest of the codebase enumerates exact MCP tool names and to keep the scope
 * pinned to search + fetch.
 */
export const EXA_MCP_ALLOWED_TOOLS = EXA_SCOPED_TOOL_NAMES.map(
  (name) => `mcp__${EXA_MCP_SERVER_NAME}__${name}` as const,
);

/**
 * Build the remote Exa MCP server config from `process.env.EXA_API_KEY`.
 *
 * - key present (non-blank after trim) → `{ type:'http', url, headers }`
 *   with the key carried in the `x-api-key` header（key 不进 URL）。
 * - key missing / blank → `null` (graceful no-op; caller must not register it).
 *
 * The key is read ONLY from the environment and is never logged by this module.
 */
export function buildExaMcpServer(): McpHttpServerConfig | null {
  const key = process.env.EXA_API_KEY?.trim();
  if (!key) return null;
  return {
    type: 'http',
    url: EXA_MCP_BASE_URL,
    headers: { 'x-api-key': key },
  } satisfies McpHttpServerConfig;
}
