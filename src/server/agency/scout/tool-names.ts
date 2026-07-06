// YUK-572 / YUK-560 — MCP tool-name single source of truth (shared scout primitive).
//
// The in-process MCP tool wire name is `mcp__<serverName>__<toolName>`. Three surfaces
// MUST agree on these strings or a spawn/allowlist silently mismatches:
//   - the evidence server registers tools under their LOCAL name (evidence-mcp.ts);
//   - the scout AgentDefinition allowlists a SUBSET of the WIRE names (scout-agent.ts);
//   - the director allowlist (PR-2) lists the read WIRE names + director-server tools.
// Deriving every wire name from ONE local-name list here — a zero-dependency pure
// module — makes local↔wire drift a compile-time impossibility rather than a runtime
// footgun (YUK-572 E-1 concern).
//
// The director write-server tool names are declared here too so scout-agent.ts can pin
// them in `disallowedTools` (belt-and-suspenders isolation) WITHOUT importing the PR-2
// director-tools module (which does not exist in PR-1).

/** In-process evidence MCP server name (director + scout share the read face). */
export const EVIDENCE_SERVER_NAME = 'research_evidence';

/** In-process director write MCP server name (PR-2). Named here only so scout can
 *  disallow its write tools; the server itself lands in PR-2. */
export const DIRECTOR_SERVER_NAME = 'research_meeting_director';

const evidenceWire = (local: string): string => `mcp__${EVIDENCE_SERVER_NAME}__${local}`;
const directorWire = (local: string): string => `mcp__${DIRECTOR_SERVER_NAME}__${local}`;

/** LOCAL names (the argument to the SDK `tool()` factory) of the 6 read-only evidence
 *  tools (scout spec §2). */
export const EVIDENCE_READ_TOOL_LOCAL_NAMES = [
  'get_attempt_details',
  'get_question',
  'get_probe_history',
  'get_typed_state',
  'get_notes',
  'get_agent_notes',
] as const;

/** LOCAL name of the YUK-562 get_traces placeholder. */
export const GET_TRACES_LOCAL_NAME = 'get_traces';

/** LOCAL name of the scout's single structured-output tool. */
export const REPORT_FINDINGS_LOCAL_NAME = 'report_findings';

/** WIRE names of the 6 read tools (director + scout allowlist these). */
export const EVIDENCE_READ_TOOL_NAMES: readonly string[] = Object.freeze(
  EVIDENCE_READ_TOOL_LOCAL_NAMES.map(evidenceWire),
);

/** get_traces WIRE name — registered on the server but NOT in the scout allowlist
 *  (YUK-572 §1/§6: scout tools = 6 read + report_findings). */
export const GET_TRACES_TOOL_NAME = evidenceWire(GET_TRACES_LOCAL_NAME);

/** report_findings WIRE name — registered on the evidence server; only the scout
 *  allowlists it (the director never reports findings). */
export const REPORT_FINDINGS_TOOL_NAME = evidenceWire(REPORT_FINDINGS_LOCAL_NAME);

/** Task — the runtime tool name that spawns a nested subagent (YUK-572 E-1: the SDK
 *  docstrings call it "the Task tool" / "the Agent tool" interchangeably; the runtime
 *  name is `Task`). scout disallows it (depth cap = 1: a scout cannot re-spawn). */
export const SPAWN_TOOL_NAME = 'Task';

/** LOCAL names of the director write tools (PR-2). */
export const DIRECTOR_WRITE_TOOL_LOCAL_NAMES = ['propose_conjecture', 'leave_agent_note'] as const;

/** WIRE names of the director write tools. scout disallows these so a nested scout can
 *  never propose / leave notes (propose-only single-proposer isolation). */
export const DIRECTOR_WRITE_TOOL_NAMES: readonly string[] = Object.freeze(
  DIRECTOR_WRITE_TOOL_LOCAL_NAMES.map(directorWire),
);
