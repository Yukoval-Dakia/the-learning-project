import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TAVILY_MCP_ALLOWED_TOOLS,
  TAVILY_MCP_SERVER_NAME,
  TAVILY_SCOPED_TOOL_NAMES,
  buildTavilyMcpServer,
} from './tavily';

describe('buildTavilyMcpServer (YUK-198)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a remote http config with the key URL-encoded into tavilyApiKey when TAVILY_API_KEY is set', () => {
    vi.stubEnv('TAVILY_API_KEY', 'tvly-secret-123');
    const cfg = buildTavilyMcpServer();
    expect(cfg).not.toBeNull();
    expect(cfg?.type).toBe('http');
    expect(cfg?.url).toBe('https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-secret-123');
    // url carries the key (only from env), nothing else added.
    expect(cfg?.url).toContain('tavilyApiKey=');
  });

  it('URL-encodes keys with special characters', () => {
    vi.stubEnv('TAVILY_API_KEY', 'a b/c?d&e');
    const cfg = buildTavilyMcpServer();
    expect(cfg?.url).toBe(
      `https://mcp.tavily.com/mcp/?tavilyApiKey=${encodeURIComponent('a b/c?d&e')}`,
    );
  });

  it('trims surrounding whitespace before deciding present vs blank', () => {
    vi.stubEnv('TAVILY_API_KEY', '  tvly-trimmed  ');
    const cfg = buildTavilyMcpServer();
    expect(cfg?.url).toBe('https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-trimmed');
  });

  it('returns null when TAVILY_API_KEY is unset (graceful no-op)', () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    expect(buildTavilyMcpServer()).toBeNull();
  });

  it('returns null when TAVILY_API_KEY is whitespace-only', () => {
    vi.stubEnv('TAVILY_API_KEY', '   ');
    expect(buildTavilyMcpServer()).toBeNull();
  });

  it('scopes allowedTools to search + extract under the tavily server name', () => {
    expect(TAVILY_MCP_SERVER_NAME).toBe('tavily');
    expect(TAVILY_SCOPED_TOOL_NAMES).toEqual(['tavily_search', 'tavily_extract']);
    expect(TAVILY_MCP_ALLOWED_TOOLS).toEqual([
      'mcp__tavily__tavily_search',
      'mcp__tavily__tavily_extract',
    ]);
    // crawl / map / research are deliberately excluded.
    expect(TAVILY_MCP_ALLOWED_TOOLS).not.toContain('mcp__tavily__tavily_crawl');
    expect(TAVILY_MCP_ALLOWED_TOOLS).not.toContain('mcp__tavily__tavily_map');
  });
});
