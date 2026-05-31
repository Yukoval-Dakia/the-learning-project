import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOMAIN_TOOL_ALLOWLISTS,
  PROPOSE_WRITE_TOOLS,
  READ_TOOLS,
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
    ]);
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
      ...READ_TOOLS,
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
    expect(listTools().map((tool) => tool.name)).toEqual([...READ_TOOLS, ...PROPOSE_WRITE_TOOLS]);
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
