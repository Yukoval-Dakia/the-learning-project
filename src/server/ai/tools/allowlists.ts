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
  // YUK-203 U4 / L-memtool — Mem0 fact-layer retrieval (D7②). Granted only to
  // coach / dreaming / copilot below; NOT to review_plan / evaluator surfaces.
  'search_memory_facts',
  // ADR-0032 D9 / YUK-304 (lane B) — 题池查询 (wraps the YUK-280 listQuestions
  // reader; drafts included by default for duplicate-avoidance). Granted to the
  // copilot surfaces ONLY for now — widening maintenance is A2 territory, so the
  // MAINTENANCE_READ_TOOLS chokepoint below filters it back out.
  'query_questions',
] as const;

export const PROPOSE_WRITE_TOOLS = [
  'propose_knowledge_edge',
  'propose_knowledge_mutation',
  'attribute_mistake',
  'propose_variant',
  'propose_learning_item_completion',
  'propose_learning_item_relearn',
  // T-D6/C (YUK-120) — Coach-driven defer/archive lane.
  'propose_learning_item_defer',
  'propose_learning_item_archive',
  'propose_record_links',
  'propose_record_promotion',
  // ADR-0032 D8 — unified question-authoring front door. Routes by seed mode to
  // the variant (runVariantGen) / record→question propose paths and (ADR-0031
  // lane B) the knowledge|material draft-question generation. MUST stay
  // positioned right after propose_record_promotion to keep the CORE_TOOLS
  // bootstrap order (and the listTools() inventory assertion in
  // allowlists.test.ts) aligned.
  'author_question',
  // YUK-195 — agent-callable question structure-edit write tools. Operate on the
  // pre-import draft layer (question_block.structured + figures); only the
  // `ingestion_block_edit` surface below grants them.
  'update_prompt',
  'add_option',
  'set_question_type',
  'split_stem',
  'merge_questions',
  'reassign_figure',
  // ADR-0031 / RP-2 (YUK-304 lane B) — copilot 组卷 write: assembles authored
  // (draft-allowed — opposite precondition from write_review_plan) + existing
  // questions into a runnable tool_quiz paper. Granted to the copilot surfaces
  // only. TAIL position mirrors the bootstrap CORE_TOOLS order (after
  // reassignFigureTool) — the listTools() inventory assertion depends on it.
  'write_quiz',
] as const;

// YUK-203 U4 / D5 / CO §6.1 — the 4 tools exclusive to the ReviewPlanTask
// surface (`review_plan`). These do NOT belong to READ_TOOLS / PROPOSE_WRITE_TOOLS
// (the Wave-3 shared surfaces): they are a narrow planner-only set. 3 reads +
// 1 write (write_review_plan emits a tool_quiz artifact). RED LINE: this surface
// reads NO memory — no search_memory_facts, no query_memory_brief (D7).
export const REVIEW_PLAN_ONLY_TOOLS = [
  'read_coach_brief',
  'get_review_knowledge_snapshot',
  'select_review_question_candidates',
  'write_review_plan',
] as const;

export type ReadDomainToolName = (typeof READ_TOOLS)[number];
export type ProposeWriteDomainToolName = (typeof PROPOSE_WRITE_TOOLS)[number];
export type ReviewPlanOnlyToolName = (typeof REVIEW_PLAN_ONLY_TOOLS)[number];
export type DomainToolName =
  | ReadDomainToolName
  | ProposeWriteDomainToolName
  | ReviewPlanOnlyToolName;

export type DomainToolSurface =
  | 'knowledge_review'
  | 'copilot'
  | 'copilot_user_suggested_mistake_action'
  | 'dreaming'
  | 'coach'
  | 'maintenance'
  // YUK-195 — question structure-correction surface (agent/user-triggered). Kept
  // separate so copilot / dreaming / coach do NOT get question-mutation tools by
  // default; this is the only surface granting the 6 draft-edit write tools.
  | 'ingestion_block_edit'
  // YUK-203 U4 / D5 — the tactical ReviewPlanTask surface. Exactly 4 tools and
  // NO memory tool (D7). Kept separate from every other surface above.
  | 'review_plan';

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
  // YUK-270 (owner 2026-06-07) — Copilot tool-surface expansion. Three readers
  // give the conversational agent learning-item lifecycle context + deeper
  // knowledge-graph traversal (subgraph expand + path finding) so it can ground
  // a lifecycle / structural suggestion before proposing one.
  'get_learning_item_context',
  'expand_knowledge_subgraph',
  'find_knowledge_paths',
  'propose_knowledge_edge',
  // YUK-270 — five write PROPOSALS (propose-only, never a direct write). Lets
  // Copilot act on what the user says in-conversation: knowledge_mutation for
  // tree reshaping (reparent/merge/split/archive/propose_new) vs the existing
  // knowledge_edge for relation links; and the learning_item lifecycle quartet
  // (complete / relearn / defer / archive) when the user explicitly says they
  // are done / want to relearn / want to push it back / want it gone. This is an
  // owner-decided surface expansion — NOT related to the U6 "skills add no tool"
  // red line (that locked the teaching/solve skill merge; this is a deliberate
  // grant). It does NOT touch the question draft-edit tools or write_review_plan.
  'propose_knowledge_mutation',
  'propose_learning_item_completion',
  'propose_learning_item_relearn',
  'propose_learning_item_defer',
  'propose_learning_item_archive',
  // ADR-0032 D8 — unified author_question front door on the copilot base surface.
  // This is the documented D8 intent (ADR-0032 D2:35 / D7:100): copilot may author
  // a variant (seed=variant) or promote a record → question (seed=record) directly
  // in-conversation, via this ONE tool. The raw `propose_variant` / `attribute_mistake`
  // tools stay OFF copilot base (they remain on `copilot_user_suggested_mistake_action`,
  // the chip surface) — author_question is a distinct tool name, so the existing
  // copilot red-lines (no `propose_variant`, no `attribute_mistake`) still hold.
  // The knowledge|material seed (ADR-0031 lane B) generates a draft question +
  // question_draft proposal — the copilot 出题 primitive.
  'author_question',
  // YUK-203 U4 / L-memtool (D7②) — Mem0 fact retrieval.
  'search_memory_facts',
  // ADR-0031 决定1/D5 + ADR-0032 D9 (YUK-304 lane B) — the quiz C→A reverse-U6
  // grant: the copilot IS the quiz orchestrator now (the C-form detectQuizIntent
  // / resolveQuizIntent / quiz-skill pre-dispatch is retired), so it carries the
  // 题池查询 read (duplicate-avoidance before authoring) and the 组卷 write
  // (assemble authored drafts + pool questions into a runnable paper). The old
  // U6 "skills add no tool" red line locked the teaching/solve BEHAVIOR-PACK
  // merge; this is the deliberate ADR-0031 surface change, not a violation.
  'query_questions',
  'write_quiz',
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
  // YUK-203 U4 / L-memtool (D7②) — Mem0 fact retrieval.
  'search_memory_facts',
] as const satisfies readonly DomainToolName[];

// T-D6/C (YUK-120) — Coach surface allowlist.
// Coach reads via the same read tools as before, plus extra propose_* tools
// covering the 4 plan_adjustments emitted by `CoachTask` (defer / split /
// relearn / archive). `propose_knowledge_mutation` covers `split`;
// `propose_learning_item_defer` and `propose_learning_item_archive` were
// added by this lane.
//
// P5.4-L2 / YUK-174 (AB-4) — added `propose_knowledge_edge` so Coach can ACT on
// the edge reason-feedback the L2 digest now feeds it (the user accepted
// widening Coach's surface with edge, 2026-05-31). Without the tool the edge
// feedback would be a dead/informational feed; the COACH objective gains brief
// when-to-propose-an-edge guidance so it is exercised.
const COACH_TOOLS = [
  'query_memory_brief',
  'query_mistakes',
  'get_attempt_context',
  'get_review_due',
  'get_learning_item_context',
  'get_question_context',
  'propose_learning_item_completion',
  'propose_learning_item_relearn',
  'propose_learning_item_defer',
  'propose_learning_item_archive',
  'propose_knowledge_mutation',
  'propose_knowledge_edge',
  // YUK-203 U4 / L-memtool (D7②) — Mem0 fact retrieval.
  'search_memory_facts',
] as const satisfies readonly DomainToolName[];

// D7③ (docs/design/2026-06-04-u0-decisions.md) — deny-from-wide: the
// evaluator/operator surfaces must NOT read memory facts. `search_memory_facts`
// now lives in READ_TOOLS (granted to coach/dreaming/copilot), so the wide
// Maintenance read base must filter it back out rather than spreading READ_TOOLS
// wholesale. This is the single chokepoint keeping Maintenance memory-free.
//
// YUK-304 (lane B, scope discipline) — `query_questions` is ALSO filtered out:
// ADR-0032 D9 grants it to the copilot surfaces only; widening maintenance is
// A2 territory, not this lane's call.
const MAINTENANCE_READ_TOOLS = READ_TOOLS.filter(
  (name): name is Exclude<ReadDomainToolName, 'search_memory_facts' | 'query_questions'> =>
    name !== 'search_memory_facts' && name !== 'query_questions',
);

const MAINTENANCE_TOOLS = [
  ...MAINTENANCE_READ_TOOLS,
  'propose_knowledge_edge',
  'propose_knowledge_mutation',
  'propose_learning_item_completion',
  'propose_learning_item_relearn',
  'propose_learning_item_defer',
  'propose_learning_item_archive',
  'propose_record_links',
  'propose_record_promotion',
] as const satisfies readonly DomainToolName[];

// YUK-195 — the question structure-correction surface. Reads enough block /
// question context to decide an edit, then the 6 draft-layer write tools. These
// write tools live ONLY here; the broader surfaces above do not grant them.
const INGESTION_BLOCK_EDIT_TOOLS = [
  'get_question_context',
  'query_events',
  'update_prompt',
  'add_option',
  'set_question_type',
  'split_stem',
  'merge_questions',
  'reassign_figure',
] as const satisfies readonly DomainToolName[];

// YUK-203 U4 / D5 / CO §6.1:668-675 — the ReviewPlanTask surface. Exactly the 4
// planner tools. RED LINE: NO search_memory_facts, NO query_memory_brief — the
// tactical planner reads no memory; the Coach brief (read_coach_brief) is its
// ONLY attention prior (D7 / CO §6.1:664-666). Enforced by an explicit
// .not.toContain test in allowlists.test.ts + review_plan.test.ts.
const REVIEW_PLAN_TOOLS = [
  'read_coach_brief',
  'get_review_knowledge_snapshot',
  'select_review_question_candidates',
  'write_review_plan',
] as const satisfies readonly DomainToolName[];

export const DOMAIN_TOOL_ALLOWLISTS = {
  knowledge_review: KNOWLEDGE_REVIEW_TOOLS,
  copilot: COPILOT_TOOLS,
  copilot_user_suggested_mistake_action: [...COPILOT_TOOLS, 'attribute_mistake', 'propose_variant'],
  dreaming: DREAMING_TOOLS,
  coach: COACH_TOOLS,
  maintenance: MAINTENANCE_TOOLS,
  ingestion_block_edit: INGESTION_BLOCK_EDIT_TOOLS,
  review_plan: REVIEW_PLAN_TOOLS,
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
