import { describe, expect, it } from 'vitest';
import { deriveGhostEndpoints } from './ghost-endpoints';
import type { KnowledgeEdgeRow, KnowledgeTreeNode } from './knowledge-api';

function node(overrides: Partial<KnowledgeTreeNode> = {}): KnowledgeTreeNode {
  return {
    id: 'yuwen-node',
    name: '语文节点',
    domain: 'yuwen',
    parent_id: null,
    effective_domain: 'yuwen',
    mastery: null,
    mastery_lo: null,
    mastery_hi: null,
    low_confidence: false,
    evidence_count: 0,
    ...overrides,
  };
}

function edge(overrides: Partial<KnowledgeEdgeRow> = {}): KnowledgeEdgeRow {
  return {
    id: 'edge-cross',
    from_knowledge_id: 'yuwen-node',
    to_knowledge_id: 'math-node',
    relation_type: 'related_to',
    weight: 1,
    status: 'active',
    ...overrides,
  };
}

describe('deriveGhostEndpoints', () => {
  it('adds an active external endpoint and marks its crossing edge', () => {
    const result = deriveGhostEndpoints(
      [node()],
      [
        node(),
        node({ id: 'math-node', name: '数学节点', domain: 'math', effective_domain: 'math' }),
      ],
      [edge()],
    );

    expect(result.nodes.map((item) => item.id)).toEqual(['yuwen-node', 'math-node']);
    expect(result.ghostIds).toEqual(new Set(['math-node']));
    expect(result.crossEdgeIds).toEqual(new Set(['edge-cross']));
  });

  it('drops an edge whose external endpoint is absent from the active full tree', () => {
    const result = deriveGhostEndpoints([node()], [node()], [edge()]);

    expect(result.nodes).toHaveLength(1);
    expect(result.ghostIds).toEqual(new Set());
    expect(result.crossEdgeIds).toEqual(new Set());
  });
});
