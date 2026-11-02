// Exa remote MCP wiring for the product agent runtime (Tavily → Exa, owner decision
// 2026-09-13).
//
// Exa ships a hosted MCP server; the pi adapter bridges it via `piRemoteMcpMount`
// to a real MCP SDK client at `https://mcp.exa.ai/mcp`. Auth goes in the `x-api-key`
// header so the key never enters the URL or logs (live-probed 2026-09-13:
// streamable-HTTP initialize + tools/list both work).
//
// The key is read ONLY from `process.env.EXA_API_KEY`. Missing/blank makes this a
// graceful no-op so the surface still runs offline.
//
// The hosted server exposes two tools, `web_search_exa` and `web_fetch_exa` — the
// 1:1 successor of tavily_search / tavily_extract.

import type { RemoteMcpHttpConfig } from '@/ai/pi-tool-mount';

/** MCP server name this helper registers under (drives the mcp__<name>__* prefix). */
export const EXA_MCP_SERVER_NAME = 'exa';

/** Hosted Exa MCP endpoint; auth travels in a header, never the URL. */
const EXA_MCP_BASE_URL = 'https://mcp.exa.ai/mcp';

/**
 * The hosted server's complete tool surface (live-probed 2026-09-13): web search
 * plus URL → markdown.
 */
export const EXA_SCOPED_TOOL_NAMES = ['web_search_exa', 'web_fetch_exa'] as const;

/**
 * `allowedTools` entries for the scoped tools, listed explicitly rather than as a
 * server-wide wildcard, matching how the codebase enumerates exact MCP tool names.
 */
export const EXA_MCP_ALLOWED_TOOLS = EXA_SCOPED_TOOL_NAMES.map(
  (name) => `mcp__${EXA_MCP_SERVER_NAME}__${name}` as const,
);

/**
 * Build the remote Exa MCP config from `process.env.EXA_API_KEY`.
 * A non-blank key yields `{type:'http', url, headers}` with the key in the
 * header; missing/blank yields null (graceful no-op — the caller must not
 * register it). The key is never logged.
 */
export function buildExaMcpServer(): RemoteMcpHttpConfig | null {
  const key = process.env.EXA_API_KEY?.trim();
  if (!key) return null;
  return {
    type: 'http',
    url: EXA_MCP_BASE_URL,
    headers: { 'x-api-key': key },
  } satisfies RemoteMcpHttpConfig;
}
