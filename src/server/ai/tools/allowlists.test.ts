import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOMAIN_TOOL_ALLOWLISTS,
  PROPOSE_WRITE_TOOLS,
  READ_TOOLS,
  REVIEW_PLAN_ONLY_TOOLS,
  resolveMcpAllowedTools,
} from './allowlists';
import { __resetBootstrapForTests, registerCoreTools } from './bootstrap';
import { __resetRegistryForTests, listTools } from './registry';

describe('DomainTool allowlist policy', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __resetBootstrapForTests();
  });

  it('keeps Wave 3 propose/write inventory explicit', () => {
    expect(PROPOSE_WRITE_TOOLS).toEqual([
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
      // ADR-0032 D8 — unified author_question front door.
      'author_question',
      // YUK-195 — question structure-edit write tools (draft layer).
      'update_prompt',
      'add_option',
      'set_question_type',
      'split_stem',
      'merge_questions',
      'reassign_figure',
      // ADR-0031 / RP-2 (YUK-304 lane B) — copilot 组卷 write (draft-allowed).
      'write_quiz',
      // ADR-0033 D6 (YUK-306 lane D) — interactive artifact authoring pair.
      'author_artifact',
      'update_artifact',
    ]);
  });

  it('grants the 6 question structure-edit tools ONLY on ingestion_block_edit', () => {
    const editTools = [
      'update_prompt',
      'add_option',
      'set_question_type',
      'split_stem',
      'merge_questions',
      'reassign_figure',
    ] as const;
    expect(DOMAIN_TOOL_ALLOWLISTS.ingestion_block_edit).toEqual([
      'get_question_context',
      'query_events',
      ...editTools,
    ]);
    // No other surface may grant any of the question-mutation write tools.
    for (const [surface, names] of Object.entries(DOMAIN_TOOL_ALLOWLISTS)) {
      if (surface === 'ingestion_block_edit') continue;
      for (const tool of editTools) {
        expect(names).not.toContain(tool);
      }
    }
  });

  it('expands Coach surface for plan_adjustments (defer / split / relearn / archive)', () => {
    expect(DOMAIN_TOOL_ALLOWLISTS.coach).toContain('propose_learning_item_defer');
    expect(DOMAIN_TOOL_ALLOWLISTS.coach).toContain('propose_learning_item_archive');
    expect(DOMAIN_TOOL_ALLOWLISTS.coach).toContain('propose_knowledge_mutation');
    expect(DOMAIN_TOOL_ALLOWLISTS.coach).toContain('propose_learning_item_relearn');
    expect(DOMAIN_TOOL_ALLOWLISTS.coach).toContain('propose_learning_item_completion');
    // P5.4-L2 / YUK-174 (AB-4) — Coach now proposes knowledge_edge so the L2
    // edge reason-feedback is actionable, not a dead grant.
    expect(DOMAIN_TOOL_ALLOWLISTS.coach).toContain('propose_knowledge_edge');
    // Coach must not reach attribute_mistake / propose_variant — those stay
    // behind the chip-triggered copilot surface.
    expect(DOMAIN_TOOL_ALLOWLISTS.coach).not.toContain('attribute_mistake');
    expect(DOMAIN_TOOL_ALLOWLISTS.coach).not.toContain('propose_variant');
  });

  it('keeps Copilot narrower than Maintenance for structural and mistake actions', () => {
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).toContain('propose_knowledge_edge');
    // YUK-270 (owner 2026-06-07) — Copilot now ALSO carries propose_knowledge_mutation
    // (tree-shape reshaping). It still stays narrower than the chip surface for the
    // user-suggested mistake actions below (attribute_mistake / propose_variant).
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).toContain('propose_knowledge_mutation');
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).not.toContain('attribute_mistake');
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).not.toContain('propose_variant');

    expect(DOMAIN_TOOL_ALLOWLISTS.copilot_user_suggested_mistake_action).toContain(
      'attribute_mistake',
    );
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot_user_suggested_mistake_action).toContain(
      'propose_variant',
    );
  });

  // AF S4 / YUK-203 U6 (R5/R6) — the teaching/solve skill merge is a behavior pack,
  // NOT a tool switch. COPILOT_TOOLS must gain NO tool from U6: no raw ask_check
  // INSERT tool, no teaching/solve-specific tool, no memory grant beyond the
  // copilot surface's pre-existing search_memory_facts. Lock the exact set.
  it('U6: the skill merge adds NO new tool to the Copilot surface (R5/R6)', () => {
    // NOTE: the Copilot surface grew in YUK-270 (owner 2026-06-07) — 3 readers +
    // knowledge_mutation + the learning_item lifecycle quartet. That was a
    // deliberate owner-decided surface expansion, NOT the U6 skill merge. The U6
    // red line still holds: the teaching/solve skill merge itself adds no tool.
    // This assertion now locks the post-YUK-270 exact set.
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).toEqual([
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
      // YUK-270 readers
      'get_learning_item_context',
      'expand_knowledge_subgraph',
      'find_knowledge_paths',
      'propose_knowledge_edge',
      // YUK-270 write proposals
      'propose_knowledge_mutation',
      'propose_learning_item_completion',
      'propose_learning_item_relearn',
      'propose_learning_item_defer',
      'propose_learning_item_archive',
      // ADR-0032 D8 — unified author_question front door on copilot base.
      'author_question',
      'search_memory_facts',
      // ADR-0031 决定1/D5 + ADR-0032 D9 (YUK-304 lane B) — quiz C→A: the copilot
      // orchestrates 出题/组卷 itself, so it reads the 题池 and writes the paper.
      'query_questions',
      'write_quiz',
      // ADR-0033 D6 (YUK-306 lane D) — the copilot authors + iterates
      // interactive artifacts itself (Claude Artifacts pattern).
      'author_artifact',
      'update_artifact',
    ]);
    // The ask_check INSERT (materializeAskCheckQuestion) is a service path, never
    // a DomainTool — it is not in COPILOT_TOOLS (R2).
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).not.toContain('materialize_ask_check');
    // No teaching/solve-specific tool name leaked onto either copilot surface.
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).not.toContain('attribute_mistake');
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot_user_suggested_mistake_action).toEqual([
      ...DOMAIN_TOOL_ALLOWLISTS.copilot,
      'attribute_mistake',
      'propose_variant',
    ]);
  });

  it('keeps Maintenance broad but excludes user-suggested mistake actions', () => {
    registerCoreTools();
    expect(DOMAIN_TOOL_ALLOWLISTS.maintenance).toEqual([
      // YUK-203 U4 / D7③ — Maintenance is an operator surface and must NOT read
      // memory facts, so its read base is READ_TOOLS minus `search_memory_facts`.
      // YUK-304 (lane B) — minus `query_questions` too (copilot-only grant;
      // widening maintenance is A2 territory). Mirrors the production chokepoint.
      ...READ_TOOLS.filter((name) => name !== 'search_memory_facts' && name !== 'query_questions'),
      'propose_knowledge_edge',
      'propose_knowledge_mutation',
      'propose_learning_item_completion',
      'propose_learning_item_relearn',
      'propose_learning_item_defer',
      'propose_learning_item_archive',
      'propose_record_links',
      'propose_record_promotion',
    ]);
    expect(DOMAIN_TOOL_ALLOWLISTS.maintenance).not.toContain('attribute_mistake');
    expect(DOMAIN_TOOL_ALLOWLISTS.maintenance).not.toContain('propose_variant');
    // YUK-203 U4 — the 4 ReviewPlanTask tools are also bootstrapped into the
    // registry (separate planner surface), so the full inventory now includes
    // them after READ + PROPOSE_WRITE.
    expect(listTools().map((tool) => tool.name)).toEqual([
      ...READ_TOOLS,
      ...PROPOSE_WRITE_TOOLS,
      ...REVIEW_PLAN_ONLY_TOOLS,
    ]);
  });

  // YUK-203 U4 / D5 / D7 — the ReviewPlanTask surface is exactly the 4 planner
  // tools and reads NO memory (CO §6.1:664-666). This is a hard red line.
  it('grants ReviewPlanTask exactly the 4 planner tools and NO memory tool', () => {
    expect(DOMAIN_TOOL_ALLOWLISTS.review_plan).toEqual([
      'read_coach_brief',
      'get_review_knowledge_snapshot',
      'select_review_question_candidates',
      'write_review_plan',
    ]);
    // RED LINE (D7): no memory tool on the planner surface.
    expect(DOMAIN_TOOL_ALLOWLISTS.review_plan).not.toContain('query_memory_brief');
    expect(DOMAIN_TOOL_ALLOWLISTS.review_plan).not.toContain('search_memory_facts');
    // And it never reaches into any propose/write tool from the shared surfaces.
    for (const tool of PROPOSE_WRITE_TOOLS) {
      expect(DOMAIN_TOOL_ALLOWLISTS.review_plan).not.toContain(tool);
    }
  });

  it('grants search_memory_facts to coach / dreaming / copilot only (D7②/③)', () => {
    // YUK-203 U4 / L-memtool — additive grant to the three soft-judgment surfaces.
    expect(READ_TOOLS).toContain('search_memory_facts');
    expect(DOMAIN_TOOL_ALLOWLISTS.coach).toContain('search_memory_facts');
    expect(DOMAIN_TOOL_ALLOWLISTS.dreaming).toContain('search_memory_facts');
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).toContain('search_memory_facts');
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot_user_suggested_mistake_action).toContain(
      'search_memory_facts',
    );
    // D7③ deny-from-wide — evaluator / operator surfaces must stay memory-free.
    expect(DOMAIN_TOOL_ALLOWLISTS.knowledge_review).not.toContain('search_memory_facts');
    expect(DOMAIN_TOOL_ALLOWLISTS.maintenance).not.toContain('search_memory_facts');
    expect(DOMAIN_TOOL_ALLOWLISTS.ingestion_block_edit).not.toContain('search_memory_facts');
  });

  // ADR-0032 D8 — the unified author_question front door. It is granted on the
  // copilot base (D2:35 / D7:100 documented intent) and is a PROPOSE_WRITE tool.
  // Adding it does NOT relax the existing copilot red-lines: the raw
  // propose_variant / attribute_mistake tools stay OFF copilot base (the variant
  // capability now reaches copilot via author_question, which is D8's intent).
  it('grants author_question on copilot base without relaxing the raw mistake-tool red-lines (ADR-0032 D8)', () => {
    expect(PROPOSE_WRITE_TOOLS).toContain('author_question');
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).toContain('author_question');
    // Inherited by the chip surface via the [...copilot, ...] spread.
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot_user_suggested_mistake_action).toContain(
      'author_question',
    );
    // RED LINE preserved: the raw mistake-authoring tools are still NOT on copilot
    // base — only the chip surface carries them. author_question is a distinct name.
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).not.toContain('propose_variant');
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).not.toContain('attribute_mistake');
    // author_question is NOT a planner / question-edit / knowledge-review tool.
    expect(DOMAIN_TOOL_ALLOWLISTS.review_plan).not.toContain('author_question');
    expect(DOMAIN_TOOL_ALLOWLISTS.ingestion_block_edit).not.toContain('author_question');
    expect(DOMAIN_TOOL_ALLOWLISTS.knowledge_review).not.toContain('author_question');
  });

  // ADR-0031 / ADR-0032 D9 (YUK-304 lane B) — the quiz C→A surface grants.
  // query_questions + write_quiz belong to the copilot surfaces ONLY (the chip
  // surface inherits via the [...copilot, ...] spread); every other surface —
  // notably maintenance / review_plan — must NOT gain them (scope discipline:
  // widening is A2 territory; review_plan keeps its own write_review_plan with
  // the OPPOSITE draft precondition).
  it('grants query_questions + write_quiz to the copilot surfaces only (ADR-0031 lane B)', () => {
    expect(READ_TOOLS).toContain('query_questions');
    expect(PROPOSE_WRITE_TOOLS).toContain('write_quiz');
    for (const tool of ['query_questions', 'write_quiz'] as const) {
      expect(DOMAIN_TOOL_ALLOWLISTS.copilot).toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.copilot_user_suggested_mistake_action).toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.maintenance).not.toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.review_plan).not.toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.knowledge_review).not.toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.ingestion_block_edit).not.toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.dreaming).not.toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.coach).not.toContain(tool);
    }
  });

  // ADR-0033 D6 (YUK-306 lane D) — interactive artifact authoring stays a
  // copilot capability (the chip surface inherits via the [...copilot, ...]
  // spread). Every other surface — notably maintenance / review_plan /
  // ingestion_block_edit — must NOT gain the pair: authoring interactive
  // content is the conversational agent's job, not an operator/planner one.
  it('grants author_artifact + update_artifact to the copilot surfaces only (ADR-0033 lane D)', () => {
    expect(PROPOSE_WRITE_TOOLS).toContain('author_artifact');
    expect(PROPOSE_WRITE_TOOLS).toContain('update_artifact');
    for (const tool of ['author_artifact', 'update_artifact'] as const) {
      expect(DOMAIN_TOOL_ALLOWLISTS.copilot).toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.copilot_user_suggested_mistake_action).toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.maintenance).not.toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.review_plan).not.toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.knowledge_review).not.toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.ingestion_block_edit).not.toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.dreaming).not.toContain(tool);
      expect(DOMAIN_TOOL_ALLOWLISTS.coach).not.toContain(tool);
    }
  });

  it('renders MCP allowedTools names for the selected server', () => {
    expect(resolveMcpAllowedTools('knowledge_review')).toEqual([
      'mcp__loom__get_subject_graph_overview',
      'mcp__loom__expand_knowledge_subgraph',
      'mcp__loom__query_knowledge',
      'mcp__loom__find_knowledge_paths',
      'mcp__loom__query_events',
      'mcp__loom__propose_knowledge_edge',
      'mcp__loom__propose_knowledge_mutation',
    ]);
  });
});
