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
  // coach / dreaming / copilot below; NOT to evaluator surfaces.
  'search_memory_facts',
  // ADR-0072 LIGHT — 题库 agent 三工具（search/read/check）随各自竖切接入。
  // 授予 copilot surfaces；备题员面（ADR-0069 第一刀）落地时再扩。Maintenance
  // chokepoint 下方过滤回（同款 containment —— 扩面归 coordinator）。
  'search_bank',
  'read_bank',
  'check_bank',
  // ADR-0032 D6-draftread (YUK-203 lane L5) — ingestion draft-layer structure
  // reader (read≡write coordinate fix). Granted ONLY on `ingestion_block_edit`
  // below; it reads the DRAFT pool (question_block.structured) so it MUST NOT
  // reach the active question face — the MAINTENANCE_READ_TOOLS chokepoint below
  // filters it back out (same containment as the bank tools).
  'get_question_block_structure',
  // YUK-939 — capability-owned generation-only tools. Neither retains a draft
  // nor writes a proposal; author_question remains the distinct retained path.
  'generate_goal_outline',
  'generate_question_candidate',
  // YUK-986 (Supply-Agent/1) — jyeoo grade-route candidate fetch. E1: registry
  // only, NO surface grant (E3/YUK-988 grants the supply-executor surface).
  // Filtered out of Maintenance below (same containment as generate_* tools).
  'jyeoo_fetch_candidates',
  // YUK-988 (Supply-Agent/3) — web-route candidate fetch (Tavily search +
  // SourcingTask extraction). E3: registry only, NO surface grant. Filtered out
  // of Maintenance below (same containment as jyeoo_fetch_candidates).
  'web_fetch_candidates',
  // YUK-293 — expiring AI-to-AI hints. Granted only to copilot / dreaming /
  // coach below; evaluator and operator surfaces filter it out.
  'read_agent_notes',
  // YUK-1404 (B2/R2) — ingestion source-package readers. Granted ONLY on the
  // `ingestion` surface below; the maintenance chokepoint filters them out
  // (same containment as the draft-structure reader).
  'read_source',
  'view_image',
] as const;

export const PROPOSE_WRITE_TOOLS = [
  'submit_review_answer',
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
  // the Failure Learning variant / record→question propose paths and (ADR-0031
  // lane B) the knowledge|material draft-question generation.
  'author_question',
  // YUK-1468 — 统一题目编辑/提交面（schema-v2 草稿文档 + ops/CAS/幂等 +
  // validate/probe）。copilot 面 save 自动落 question_edit proposal。
  'edit_question',
  'submit_question',
  // YUK-1468 — 六个窄薄壳与窄 propose 工具【仍在 inventory（manifest 注册、
  // DomainToolName 合法）但无任何 surface 授权】：下方各 surface 数组均不
  // 授它们，模块与测试随 owner 批准后的独立删除 PR 清理。
  'update_prompt',
  'add_option',
  'set_question_type',
  'split_stem',
  'merge_questions',
  'reassign_figure',
  'propose_question_edit',
  // store_sourced_question 已由 submit_question 接管，工具名退出 inventory
  // （plan-executor/测试 import 的是 compat 模块的 executeStoreSourcedQuestion
  // 函数，不解析工具名）；manifest 不再注册、无 surface 授权。
  // YUK-1497 (K5) — presentation composition tool; same containment as the six
  // draft-edit tools above (writes ONE jsonb-internal key of the draft container).
  'compose_presentation',
  // ADR-0031 / RP-2 (YUK-304 lane B) — copilot 组卷 write: assembles authored
  // (draft-allowed) + existing
  // questions into a runnable tool_quiz paper. Granted to the copilot surfaces
  // only.
  'write_quiz',
  // ADR-0033 D6 (YUK-306, lane D) — interactive artifact authoring: the copilot
  // writes the HTML itself in-conversation (Claude Artifacts pattern) and
  // persists it as a versioned type='interactive' artifact (author = create v0,
  // update = full-html replace + version bump). Granted to the copilot surfaces
  // only.
  'author_artifact',
  'update_artifact',
  // YUK-293 — direct write to the expiring AI hint channel (not learner data,
  // not an inbox proposal). Surface grants remain narrow below.
  'write_agent_note',
  // YUK-1404 (B2/R3–R5) — ingestion media tools. crop/rotate mint derived
  // source_asset rows; glm_ocr is a paid provider call (attempt-accounted).
  // Granted ONLY on the `ingestion` surface below.
  'crop_image',
  'rotate_image',
  'glm_ocr',
  // YUK-1448 (Stage 1 batch D) — search_bank 检索不足时的缺口落单工具（幂等台账
  // 登记 + 既有 dispatcher；held/unsupported_constraint 不静默丢字段）。授权面：
  // 仅 copilot（COPILOT_TOOLS）；supply_planner 保持只读挂载；不进 Maintenance
  // （备题/供给域写工具，非运维面）。
  'file_bank_gap',
  // YUK-1522 (R8) — ingestion agent contract tools. report_ingestion_progress
  // writes the durable stage/item/error event stream; ask_learner creates and
  // polls durable learner asks (never blocks). Granted ONLY on the `ingestion`
  // surface below.
  'report_ingestion_progress',
  'ask_learner',
  // YUK-1407 — 判分纠错提案（可逆，人审 accept 才经 appeal/rejudge/CAS+replay
  // 生效）。授予发现疑似误判的 agent 面：copilot / dreaming / coach。
  'propose_grading_correction',
] as const;

// YUK-949 — model-authored presentation intent. This is neither a data read nor
// a proposal/write; the server validates it against the completed root trace.
export const CONTROL_TOOLS = ['present_primary_view'] as const;

export type ReadDomainToolName = (typeof READ_TOOLS)[number];
export type ProposeWriteDomainToolName = (typeof PROPOSE_WRITE_TOOLS)[number];
export type ControlDomainToolName = (typeof CONTROL_TOOLS)[number];
export type DomainToolName =
  | ReadDomainToolName
  | ProposeWriteDomainToolName
  | ControlDomainToolName;

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
  // YUK-1404 (B2/R2) — the ingestion extraction-agent surface. Carries the
  // five shared source-package tools only; no question-mutation tools, no
  // bank/record tools.
  | 'ingestion';

const KNOWLEDGE_REVIEW_TOOLS = [
  'get_subject_graph_overview',
  'expand_knowledge_subgraph',
  'query_knowledge',
  'find_knowledge_paths',
  'query_events',
  'propose_knowledge_edge',
  'propose_knowledge_mutation',
] as const satisfies readonly DomainToolName[];

// M5-T3 / YUK-328 — 完整 DomainTool 归属真相源已移至各包 manifest.copilotTools；
// 字段名沿用，但 inventory 包含非 Copilot surface 的工具。COPILOT_TOOLS 仍保持
// 字面量，因为 src/ai/registry.ts（浏览器共享面）import 本文件，不能把
// @/capabilities 拉进 web bundle（plan 裁决 h）。完整 inventory 与 Copilot 子集的
// 集合对账均由 src/capabilities/copilot/server/copilot-tools.unit.test.ts 强制。
export const COPILOT_TOOLS = [
  'submit_review_answer',
  'present_primary_view',
  'query_memory_brief',
  'generate_goal_outline',
  'generate_question_candidate',
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
  // grant). It does NOT touch the question draft-edit tools.
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
  'write_quiz',
  // ADR-0072 LIGHT — 题库三工具接替已删除的 query_questions 的取题路径（D1：
  // LIGHT 只切 copilot/备题员两个面；coach/dreaming/maintenance/ingestion_block_edit
  // 继续经现有 get_question_context 读取不变）。
  'search_bank',
  'read_bank',
  'check_bank',
  // YUK-1448 (Stage 1 batch D) — copilot 检索后可直接落缺口单（search_bank 已在
  // 本面；供给侧回执走既有 dispatcher 台账）。
  'file_bank_gap',
  // ADR-0033 D6 (YUK-306, lane D) — interactive 学习 artifact authoring pair.
  // effect='write' (单用户、路由守 scope、非破坏性创建 — D6 explicit); the chip
  // surface inherits via the [...COPILOT_TOOLS, …] spread below. No other
  // surface gets them.
  'author_artifact',
  'update_artifact',
  // YUK-1468 — Copilot 编辑面：edit_question（ops/document/validate/probe）。
  // copilot 调 save 时工具按 caller surface 自动落 question_edit proposal
  // （accept applier 走同一 ops → submit gate）；validate/probe 直出。
  'edit_question',
  'read_agent_notes',
  'write_agent_note',
  // YUK-1407 — 判分纠错提案（对话中发现疑似误判时可落地；accept 仍人审）。
  'propose_grading_correction',
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
  'read_agent_notes',
  'write_agent_note',
  // YUK-1407 — dreaming 复核中发现疑似误判 → 可逆纠错提案。
  'propose_grading_correction',
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
  'read_agent_notes',
  'write_agent_note',
  // YUK-1407 — coach 复盘发现疑似误判 → 可逆纠错提案。
  'propose_grading_correction',
] as const satisfies readonly DomainToolName[];

// D7③ (docs/design/2026-06-04-u0-decisions.md) — deny-from-wide: the
// evaluator/operator surfaces must NOT read memory facts. `search_memory_facts`
// now lives in READ_TOOLS (granted to coach/dreaming/copilot), so the wide
// Maintenance read base must filter it back out rather than spreading READ_TOOLS
// wholesale. This is the single chokepoint keeping Maintenance memory-free.
//
// ADR-0032 D9 granted query_questions (since removed — ADR-0072 search_bank
// replaces it) to the copilot surfaces only; widening maintenance is A2
// territory, not this lane's call.
//
// ADR-0072 LIGHT — the bank tools (search/read/check_bank) follow the same
// containment: copilot-surface grants only; widening is the coordinator's call.
//
// ADR-0032 D6-draftread (YUK-203 lane L5) — `get_question_block_structure` is
// filtered out for the same reason: it reads the ingestion DRAFT layer and is an
// `ingestion_block_edit`-only grant. Keeping the chokepoint here stops it leaking
// onto the operator/evaluator (Maintenance) surface — i.e. the active題面.
const MAINTENANCE_READ_TOOLS = READ_TOOLS.filter(
  (
    name,
  ): name is Exclude<
    ReadDomainToolName,
    | 'search_memory_facts'
    | 'search_bank'
    | 'read_bank'
    | 'check_bank'
    | 'get_question_block_structure'
    | 'generate_goal_outline'
    | 'generate_question_candidate'
    | 'jyeoo_fetch_candidates'
    | 'web_fetch_candidates'
    | 'read_agent_notes'
    | 'read_source'
    | 'view_image'
  > =>
    name !== 'search_memory_facts' &&
    name !== 'search_bank' &&
    name !== 'read_bank' &&
    name !== 'check_bank' &&
    name !== 'get_question_block_structure' &&
    name !== 'generate_goal_outline' &&
    name !== 'generate_question_candidate' &&
    name !== 'jyeoo_fetch_candidates' &&
    name !== 'web_fetch_candidates' &&
    name !== 'read_agent_notes' &&
    name !== 'read_source' &&
    name !== 'view_image',
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
  // ADR-0032 D6-draftread (YUK-203 lane L5) — the draft-layer structure reader.
  // Lets the edit agent read the block by node-id (the same coordinate system the
  // edit ops below address) before mutating it. Draft-only; no other surface
  // grants it.
  'get_question_block_structure',
  'query_events',
  // YUK-1468 — 统一编辑/提交面（六个窄薄壳已并入；draft ops 写 + submit 闸）。
  'edit_question',
  'submit_question',
  // YUK-1497 (K5) — compose_presentation；与上述写工具同面（草稿层），
  // 别的面不授。
  'compose_presentation',
] as const satisfies readonly DomainToolName[];

// YUK-1404 (B2/R2–R5) — the ingestion extraction-agent surface. Scoping INSIDE
// the tools (ctx.scope) pins reads/writes to the calling session's own package;
// this list is the only place they are granted.
//
// YUK-1522 (R8) — the R8 agent additionally gets the unified draft lane
// (edit_question / compose_presentation / submit_question — the same write
// path as ingestion_block_edit, still withheld-pending-admission) and its two
// contract tools (progress + durable asks). No bank/record tools.
const INGESTION_TOOLS = [
  'read_source',
  'view_image',
  'crop_image',
  'rotate_image',
  'glm_ocr',
  'get_question_block_structure',
  'edit_question',
  'compose_presentation',
  'submit_question',
  'report_ingestion_progress',
  'ask_learner',
] as const satisfies readonly DomainToolName[];

export const DOMAIN_TOOL_ALLOWLISTS = {
  knowledge_review: KNOWLEDGE_REVIEW_TOOLS,
  copilot: COPILOT_TOOLS,
  copilot_user_suggested_mistake_action: [...COPILOT_TOOLS, 'attribute_mistake', 'propose_variant'],
  dreaming: DREAMING_TOOLS,
  coach: COACH_TOOLS,
  maintenance: MAINTENANCE_TOOLS,
  ingestion_block_edit: INGESTION_BLOCK_EDIT_TOOLS,
  ingestion: INGESTION_TOOLS,
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
