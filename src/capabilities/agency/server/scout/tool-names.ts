// MCP tool-name single source of truth.
//
// The wire name is `mcp__<serverName>__<toolName>`. Deriving every wire name from one
// local-name list here keeps the evidence server, scout allowlist, and director
// allowlist from drifting. Director write names are declared here too so scout-agent.ts
// can disallow them without importing the director-tools module.

/** In-process evidence MCP server name (director + scout share the read face). */
export const EVIDENCE_SERVER_NAME = 'research_evidence';

/** In-process director write MCP server name; named here so scout can disallow its
 *  write tools without importing the director-tools module. */
export const DIRECTOR_SERVER_NAME = 'research_meeting_director';

const evidenceWire = (local: string): string => `mcp__${EVIDENCE_SERVER_NAME}__${local}`;
const directorWire = (local: string): string => `mcp__${DIRECTOR_SERVER_NAME}__${local}`;

/** LOCAL names (the argument to the SDK `tool()` factory) of the 6 read-only evidence
 *  tools. */
export const EVIDENCE_READ_TOOL_LOCAL_NAMES = [
  'get_attempt_details',
  'get_question',
  'get_probe_history',
  'get_typed_state',
  'get_notes',
  'get_agent_notes',
] as const;

/** LOCAL name of the get_traces placeholder. */
export const GET_TRACES_LOCAL_NAME = 'get_traces';

/** LOCAL name of the scout's single structured-output tool. */
export const REPORT_FINDINGS_LOCAL_NAME = 'report_findings';

/** WIRE names of the 6 read tools (director + scout allowlist these). */
export const EVIDENCE_READ_TOOL_NAMES: readonly string[] = Object.freeze(
  EVIDENCE_READ_TOOL_LOCAL_NAMES.map(evidenceWire),
);

/** get_traces WIRE name — registered on the server but NOT in the scout allowlist
 *  (scout tools = 6 read + report_findings). */
export const GET_TRACES_TOOL_NAME = evidenceWire(GET_TRACES_LOCAL_NAME);

/** report_findings WIRE name — registered on the evidence server; only the scout
 *  allowlists it (the director never reports findings). */
export const REPORT_FINDINGS_TOOL_NAME = evidenceWire(REPORT_FINDINGS_LOCAL_NAME);

/** Task — the runtime tool name that spawns a nested subagent (the SDK docstrings call
 *  it "the Task tool" / "the Agent tool" interchangeably). scout disallows it
 *  (depth cap = 1: a scout cannot re-spawn). */
export const SPAWN_TOOL_NAME = 'Task';

/** LOCAL names of the director write tools. */
export const DIRECTOR_WRITE_TOOL_LOCAL_NAMES = ['propose_conjecture', 'leave_agent_note'] as const;

/** WIRE names of the director write tools. scout disallows these so a nested scout can
 *  never propose / leave notes (single-proposer isolation). */
export const DIRECTOR_WRITE_TOOL_NAMES: readonly string[] = Object.freeze(
  DIRECTOR_WRITE_TOOL_LOCAL_NAMES.map(directorWire),
);
