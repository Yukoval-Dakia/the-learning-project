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
      'propose_record_links',
      'propose_record_promotion',
    ]);
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

  it('allows Maintenance to see every registered read/propose/write DomainTool', () => {
    registerCoreTools();
    expect(DOMAIN_TOOL_ALLOWLISTS.maintenance).toEqual(listTools().map((tool) => tool.name));
    expect(DOMAIN_TOOL_ALLOWLISTS.maintenance).toEqual([...READ_TOOLS, ...PROPOSE_WRITE_TOOLS]);
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
