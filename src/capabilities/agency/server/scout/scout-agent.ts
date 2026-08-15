// YUK-572 §1/§6 — evidence-scout AgentDefinition assembler (shared scout primitive).
//
// Assembles the scout spec §3 three-question task book into an SDK AgentDefinition
// that the director spawns via `agents: { 'evidence-scout': ... }`. PURE assembly —
// no DB, no LLM, no SDK call. The prompt is injected (registry-inline SoT lives with
// the caller); this module owns only the STRUCTURAL isolation shape:
//
//   - `tools` is ALWAYS explicitly enumerated, NEVER omitted. Omitting it makes the
//     subagent inherit ALL parent tools (sdk.d.ts:44 "If omitted, inherits all tools
//     from parent") — which would leak `Task` (breaking the anti-swarm DEPTH cap: a
//     scout could re-spawn) AND the director's propose/note write tools (breaking the
//     propose-only single-proposer isolation). This is the YUK-572 A1 red line.
//   - `disallowedTools` re-lists Task + the two director write tools as belt-and-
//     suspenders — even a future tools-list edit can't re-open the isolation break.
//   - `mcpServers` references the shared top-level `research_evidence` server BY NAME
//     (YUK-572 E-3 primary form).
//   - `maxTurns` caps the scout sub-session.

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import {
  DIRECTOR_WRITE_TOOL_NAMES,
  EVIDENCE_READ_TOOL_NAMES,
  EVIDENCE_SERVER_NAME,
  REPORT_FINDINGS_TOOL_NAME,
  SPAWN_TOOL_NAME,
} from './tool-names';

/** Scout sub-session turn cap (scout spec §3: 6-8 reads + report_findings, +margin). */
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
 * Build the evidence-scout AgentDefinition. `tools` is the 6 read tools +
 * report_findings — explicitly enumerated (NO get_traces: it is a YUK-562 placeholder
 * the prompt tells the scout not to call, so it stays out of the allowlist entirely).
 */
export function buildEvidenceScoutAgentDefinition(opts: BuildEvidenceScoutOpts): AgentDefinition {
  return {
    description: opts.description ?? DEFAULT_DESCRIPTION,
    prompt: opts.prompt,
    // model OMITTED ⇒ inherits the main thread's model (opus on the anthropic-sub lane).
    // "继承主线程" (spec §1/§6); the SDK documents omit / 'inherit' as the main model.
    tools: [...EVIDENCE_READ_TOOL_NAMES, REPORT_FINDINGS_TOOL_NAME],
    disallowedTools: [SPAWN_TOOL_NAME, ...DIRECTOR_WRITE_TOOL_NAMES],
    // By-name reference to the top-level in-process server (E-3: runtime resolution
    // unverified until PR-2 dev validation; fallback form is {type:'sdk',name}).
    mcpServers: [EVIDENCE_SERVER_NAME],
    maxTurns: EVIDENCE_SCOUT_MAX_TURNS,
  };
}
