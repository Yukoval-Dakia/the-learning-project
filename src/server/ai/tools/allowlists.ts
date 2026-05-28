// Wave 3 / T-D4 DomainTool surface policy.
//
// This is the narrow allowlist matrix from
// docs/superpowers/specs/2026-05-17-agent-context-tools-design.md. Runtime
// callers can build an MCP server from these names and pass the matching
// mcp__loom__* names into runTask/streamTask allowedTools.

export const DOMAIN_TOOL_MCP_SERVER_NAME = 'loom';

export const READ_TOOLS = [
  'query_mistakes',
  'query_events',
  'get_attempt_context',
  'get_subject_graph_overview',
  'query_knowledge',
  'expand_knowledge_subgraph',
  'find_knowledge_paths',
  'query_records',
  'get_record_context',
  'get_question_context',
  'get_review_due',
  'get_learning_item_context',
  'query_memory_brief',
] as const;

export const PROPOSE_WRITE_TOOLS = [
  'propose_knowledge_edge',
  'propose_knowledge_mutation',
  'attribute_mistake',
  'propose_variant',
  'propose_learning_item_completion',
  'propose_learning_item_relearn',
  'propose_record_links',
  'propose_record_promotion',
] as const;

export type ReadDomainToolName = (typeof READ_TOOLS)[number];
export type ProposeWriteDomainToolName = (typeof PROPOSE_WRITE_TOOLS)[number];
export type DomainToolName = ReadDomainToolName | ProposeWriteDomainToolName;

export type DomainToolSurface =
  | 'knowledge_review'
  | 'copilot'
  | 'copilot_user_suggested_mistake_action'
  | 'dreaming'
  | 'coach'
  | 'maintenance';

const KNOWLEDGE_REVIEW_TOOLS = [
  'get_subject_graph_overview',
  'expand_knowledge_subgraph',
  'query_knowledge',
  'find_knowledge_paths',
  'query_events',
  'propose_knowledge_edge',
  'propose_knowledge_mutation',
] as const satisfies readonly DomainToolName[];

const COPILOT_TOOLS = [
  'query_memory_brief',
  'get_subject_graph_overview',
  'query_knowledge',
  'query_events',
  'query_records',
  'get_record_context',
  'get_question_context',
  'query_mistakes',
  'get_attempt_context',
  'get_review_due',
  'propose_knowledge_edge',
] as const satisfies readonly DomainToolName[];

const DREAMING_TOOLS = [
  ...KNOWLEDGE_REVIEW_TOOLS,
  'query_records',
  'get_question_context',
  'query_mistakes',
  'get_learning_item_context',
  'query_memory_brief',
  'propose_learning_item_completion',
  'propose_learning_item_relearn',
  'propose_record_links',
  'propose_record_promotion',
] as const satisfies readonly DomainToolName[];

const COACH_TOOLS = [
  'query_memory_brief',
  'query_mistakes',
  'get_attempt_context',
  'get_review_due',
  'get_learning_item_context',
  'get_question_context',
  'propose_learning_item_completion',
  'propose_learning_item_relearn',
] as const satisfies readonly DomainToolName[];

export const DOMAIN_TOOL_ALLOWLISTS = {
  knowledge_review: KNOWLEDGE_REVIEW_TOOLS,
  copilot: COPILOT_TOOLS,
  copilot_user_suggested_mistake_action: [...COPILOT_TOOLS, 'attribute_mistake', 'propose_variant'],
  dreaming: DREAMING_TOOLS,
  coach: COACH_TOOLS,
  maintenance: [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS],
} as const satisfies Record<DomainToolSurface, readonly DomainToolName[]>;

export function resolveDomainToolNames(surface: DomainToolSurface): readonly DomainToolName[] {
  return DOMAIN_TOOL_ALLOWLISTS[surface];
}

export function toMcpAllowedToolName(
  name: DomainToolName,
  serverName = DOMAIN_TOOL_MCP_SERVER_NAME,
): `mcp__${string}__${DomainToolName}` {
  return `mcp__${serverName}__${name}`;
}

export function resolveMcpAllowedTools(
  surface: DomainToolSurface,
  serverName = DOMAIN_TOOL_MCP_SERVER_NAME,
): readonly `mcp__${string}__${DomainToolName}`[] {
  return resolveDomainToolNames(surface).map((name) => toMcpAllowedToolName(name, serverName));
}
