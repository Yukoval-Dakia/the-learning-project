import type {
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * YUK-837 actual-provider fixture — real Claude Agent SDK hook payloads for a
 * hosted remote-MCP web-search tool (`mcp__exa__web_search_exa`), captured
 * 2026-09-13 from a live probe (SDK @anthropic-ai/claude-agent-sdk@0.3.220,
 * repo buildExaMcpServer() mount, zhipu/glm-5.2 lane) so complex mocks reuse the
 * observed runtime shape instead of a hand-written schema.
 *
 * Observed over the whole probe run (693 PostToolUse + 2 PostToolUseFailure,
 * every `tool_use_id` unique):
 * - `tool_response` is the MCP content ARRAY — `[{ type: 'text', text, _meta? }]`
 *   (not a string/object); `_meta.searchTime` is the one extra per-block key.
 * - `tool_input` for this tool: `{ query, objective, numResults }`.
 * - failures carry `error` + `is_interrupt` and NO `tool_response`.
 * - `agent_id` was absent for every parent-process call (the probe spawned no
 *   subagent; the SDK documents agent_id as present only inside subagents).
 * - runtime payloads carry extra keys outside the SDK type (`effort`); they are
 *   intentionally not modeled here.
 *
 * Sanitized: real session/transcript/cwd/prompt ids replaced with probe
 * placeholders; tool_input/tool_response/error/tool_use_id/duration_ms kept
 * byte-for-byte from the capture. Raw full capture: worktree `.remember/yuk837-evidence/`
 * (gitignored, biome-excluded local evidence).
 */

export const EXA_WEB_SEARCH_POST_TOOL_USE = {
  session_id: 'probe_session_0001',
  transcript_path: '/tmp/probe/transcript.jsonl',
  cwd: '/tmp/probe',
  prompt_id: 'probe_prompt_0001',
  permission_mode: 'default',
  hook_event_name: 'PostToolUse',
  tool_name: 'mcp__exa__web_search_exa',
  tool_input: {
    numResults: 1,
    objective: 'find a page stating the derivative of e^x',
    query: 'derivative of e^x proof',
  },
  tool_use_id: 'call_9cea61a7cc314aa5a35c04a8',
  duration_ms: 1495,
  tool_response: [
    {
      type: 'text',
      text: 'Title: Proof: The derivative of 𝑒ˣ is 𝑒ˣ (article) - Khan Academy\nURL: https://www.khanacademy.org/math/ap-calculus-bc/bc-differentiation-1-new/bc-2-7/a/proof-the-derivative-of-is\nPublished: N/A\nAuthor: N/A\nHighlights:\nClient Challenge\n\nA required part of this site couldn’t load. This may be due to a browser extension, network issues, or browser settings. Please check your connection, disable any ad blockers, or try using a different browser.',
      _meta: {
        searchTime: 1198.4,
      },
    },
  ],
} satisfies PostToolUseHookInput;

export const EXA_WEB_SEARCH_POST_TOOL_USE_FAILURE = {
  session_id: 'probe_session_0001',
  transcript_path: '/tmp/probe/transcript.jsonl',
  cwd: '/tmp/probe',
  prompt_id: 'probe_prompt_0001',
  permission_mode: 'default',
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'mcp__exa__web_search_exa',
  tool_input: {
    numResults: 1,
    objective: 'find a page stating the derivative of e^x',
    query: 'derivative of e^x proof',
  },
  tool_use_id: 'call_2988d2e479a64c09bb7f9c80',
  duration_ms: 101,
  error:
    'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
  is_interrupt: false,
} satisfies PostToolUseFailureHookInput;
