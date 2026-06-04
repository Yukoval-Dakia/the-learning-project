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
      // YUK-195 — question structure-edit write tools (draft layer).
      'update_prompt',
      'add_option',
      'set_question_type',
      'split_stem',
      'merge_questions',
      'reassign_figure',
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
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).not.toContain('propose_knowledge_mutation');
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).not.toContain('attribute_mistake');
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot).not.toContain('propose_variant');

    expect(DOMAIN_TOOL_ALLOWLISTS.copilot_user_suggested_mistake_action).toContain(
      'attribute_mistake',
    );
    expect(DOMAIN_TOOL_ALLOWLISTS.copilot_user_suggested_mistake_action).toContain(
      'propose_variant',
    );
  });

  it('keeps Maintenance broad but excludes user-suggested mistake actions', () => {
    registerCoreTools();
    expect(DOMAIN_TOOL_ALLOWLISTS.maintenance).toEqual([
      // YUK-203 U4 / D7③ — Maintenance is an operator surface and must NOT read
      // memory facts, so its read base is READ_TOOLS minus `search_memory_facts`.
      ...READ_TOOLS.filter((name) => name !== 'search_memory_facts'),
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
