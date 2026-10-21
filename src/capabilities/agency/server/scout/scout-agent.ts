// Evidence-scout AgentDefinition assembler.
//
// PURE assembly — no DB, no LLM, no provider call. The prompt is injected by the
// caller. Structural isolation is the point:
//   - `tools` is ALWAYS explicitly enumerated, NEVER omitted. Omitting it makes the
//     subagent inherit ALL parent tools — including `Task` (breaking the depth-one cap:
//     a scout could re-spawn) and the director's write tools.
//   - `disallowedTools` re-lists Task + the two director write tools as
//     belt-and-suspenders.
//   - `maxTurns` caps the scout sub-session.

import type { AgentDefinition } from '@/server/ai/sdk-types';
import {
  DIRECTOR_WRITE_TOOL_NAMES,
  EVIDENCE_READ_TOOL_NAMES,
  REPORT_FINDINGS_TOOL_NAME,
  SPAWN_TOOL_NAME,
} from './tool-names';

/** Scout sub-session turn cap (6-8 reads + report_findings, + margin). */
export const EVIDENCE_SCOUT_MAX_TURNS = 12;

const DEFAULT_DESCRIPTION =
  'Deep-dive evidence scout. Runs ONE focused read-only investigation of a single ' +
  'knowledge-point × cause cell and reports the three-question findings back via ' +
  'report_findings. Read-only, propose-nothing, cannot spawn further subagents.';

export interface BuildEvidenceScoutOpts {
  /** The three-question task-book system prompt (registry-inline SoT, subject-neutral). */
  prompt: string;
  /** Optional override of the natural-language "when to use" description. */
  description?: string;
}

/**
 * Build the evidence-scout AgentDefinition: 6 read tools + report_findings, no
 * get_traces (the prompt tells the scout not to call it).
 */
export function buildEvidenceScoutAgentDefinition(opts: BuildEvidenceScoutOpts): AgentDefinition {
  return {
    description: opts.description ?? DEFAULT_DESCRIPTION,
    prompt: opts.prompt,
    // model OMITTED ⇒ inherits the main thread's model (opus on the anthropic-sub lane).
    // The SDK documents omit / 'inherit' as the main model.
    tools: [...EVIDENCE_READ_TOOL_NAMES, REPORT_FINDINGS_TOOL_NAME],
    disallowedTools: [SPAWN_TOOL_NAME, ...DIRECTOR_WRITE_TOOL_NAMES],
    maxTurns: EVIDENCE_SCOUT_MAX_TURNS,
  };
}
