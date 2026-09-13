import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXA_MCP_ALLOWED_TOOLS,
  EXA_MCP_SERVER_NAME,
  EXA_SCOPED_TOOL_NAMES,
  buildExaMcpServer,
} from './exa';

describe('buildExaMcpServer (Tavily → Exa 换装)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a remote http config with the key in the x-api-key header when EXA_API_KEY is set', () => {
    vi.stubEnv('EXA_API_KEY', 'exa-secret-123');
    const cfg = buildExaMcpServer();
    expect(cfg).not.toBeNull();
    expect(cfg?.type).toBe('http');
    expect(cfg?.url).toBe('https://mcp.exa.ai/mcp');
    // key travels in the header, never in the URL.
    expect(cfg?.headers).toEqual({ 'x-api-key': 'exa-secret-123' });
    expect(cfg?.url).not.toContain('exa-secret-123');
  });

  it('passes keys with special characters through the header verbatim (no URL encoding needed)', () => {
    vi.stubEnv('EXA_API_KEY', 'a b/c?d&e');
    const cfg = buildExaMcpServer();
    expect(cfg?.headers).toEqual({ 'x-api-key': 'a b/c?d&e' });
    expect(cfg?.url).toBe('https://mcp.exa.ai/mcp');
  });

  it('trims surrounding whitespace before deciding present vs blank', () => {
    vi.stubEnv('EXA_API_KEY', '  exa-trimmed  ');
    const cfg = buildExaMcpServer();
    expect(cfg?.headers).toEqual({ 'x-api-key': 'exa-trimmed' });
  });

  it('returns null when EXA_API_KEY is unset (graceful no-op)', () => {
    vi.stubEnv('EXA_API_KEY', '');
    expect(buildExaMcpServer()).toBeNull();
  });

  it('returns null when EXA_API_KEY is whitespace-only', () => {
    vi.stubEnv('EXA_API_KEY', '   ');
    expect(buildExaMcpServer()).toBeNull();
  });

  it('scopes allowedTools to search + fetch under the exa server name (live-probed 2026-09-13: hosted server exposes exactly these two)', () => {
    expect(EXA_MCP_SERVER_NAME).toBe('exa');
    expect(EXA_SCOPED_TOOL_NAMES).toEqual(['web_search_exa', 'web_fetch_exa']);
    expect(EXA_MCP_ALLOWED_TOOLS).toEqual(['mcp__exa__web_search_exa', 'mcp__exa__web_fetch_exa']);
  });
});
