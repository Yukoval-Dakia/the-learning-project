import type { PiToolCallObservation } from '@/server/ai/pi-hooks';

/**
 * YUK-837 actual-provider fixture — real hook payloads for a hosted remote-MCP
 * web-search tool (`mcp__exa__web_search_exa`), captured 2026-09-13 from a live
 * probe (repo buildExaMcpServer() mount, zhipu/glm-5.2 lane) so complex mocks
 * reuse the observed runtime shape instead of a hand-written schema.
 *
 * YUK-1025 P4 — re-expressed as PiToolCallObservation: `tool_input` → `args`,
 * `tool_response` → `output`, `is_interrupt` → `interrupted`, `tool_use_id` →
 * `call.id`. Field values kept byte-for-byte from the capture.
 *
 * Observed over the whole probe run (693 PostToolUse + 2 PostToolUseFailure,
 * every `tool_use_id` unique):
 * - `tool_response` is the MCP content ARRAY — `[{ type: 'text', text, _meta? }]`
 *   (not a string/object); `_meta.searchTime` is the one extra per-block key.
 * - `tool_input` for this tool: `{ query, objective, numResults }`.
 * - failures carry `error` + `interrupted` and NO `output`.
 * - `agent_id` was absent for every parent-process call (the probe spawned no
 *   subagent); pi's `call.agentType` plays that role on nested loops.
 *
 * Sanitized: real session/transcript/cwd/prompt ids dropped (pi observations
 * don't carry them); tool args/output/error/call.id/duration kept verbatim.
 * Raw full capture: worktree `.remember/yuk837-evidence/` (gitignored,
 * biome-excluded local evidence).
 */

export const EXA_WEB_SEARCH_OBSERVATION = {
  call: { id: 'call_9cea61a7cc314aa5a35c04a8', name: 'mcp__exa__web_search_exa' },
  args: {
    numResults: 1,
    objective: 'find a page stating the derivative of e^x',
    query: 'derivative of e^x proof',
  },
  isError: false,
  output: [
    {
      type: 'text',
      text: 'Title: Proof: The derivative of 𝑒ˣ is 𝑒ˣ (article) - Khan Academy\nURL: https://www.khanacademy.org/math/ap-calculus-bc/bc-differentiation-1-new/bc-2-7/a/proof-the-derivative-of-is\nPublished: N/A\nAuthor: N/A\nHighlights:\nClient Challenge\n\nA required part of this site couldn’t load. This may be due to a browser extension, network issues, or browser settings. Please check your connection, disable any ad blockers, or try using a different browser.',
      _meta: {
        searchTime: 1198.4,
      },
    },
  ],
  duration_ms: 1495,
} satisfies PiToolCallObservation & { duration_ms: number };

export const EXA_WEB_SEARCH_FAILURE_OBSERVATION = {
  call: { id: 'call_2988d2e479a64c09bb7f9c80', name: 'mcp__exa__web_search_exa' },
  args: {
    numResults: 1,
    objective: 'find a page stating the derivative of e^x',
    query: 'derivative of e^x proof',
  },
  isError: true,
  error:
    'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
  interrupted: false,
  duration_ms: 101,
} satisfies PiToolCallObservation & { duration_ms: number };
