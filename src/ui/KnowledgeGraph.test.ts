// Wave 7 T-KG (YUK-142) — unit tests for the extracted pure functions behind
// the cytoscape KnowledgeGraph primitive. No DOM / cytoscape instance is created
// here (buildElements/buildStylesheet return plain JSON; the band/filter helpers
// are pure), so this lives in the unit partition (src/ui/**/*.test.ts).
//
// Covers:
//   Slice 1a — buildElements (tree/mesh edges, dangling-endpoint skip,
//     experimental relation_type → related_to fallback, node diameter/edge width
//     formulas, mesh-over-tree z-index) + buildStylesheet (per-relation styles).
//   Slice 1b + Fix B — masteryBand / passesFilter / isWeakish / distinctDomains
//     band thresholds incl. the new insufficient band, boundary values
//     0.4 / 0.7 / null / the 0.5 low-evidence sentinel, and filter composition.

import { describe, expect, it } from 'vitest';
import {
  type FilterState,
  type KnowledgeEdgeProposal,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  type NodeDueSummary,
  RELATION_VISUAL,
  TOKEN_NAMES,
  type TokenMap,
  buildElements,
  buildProposedEdgeElements,
  buildStylesheet,
  distinctDomains,
  isWeakish,
  masteryBand,
  nodeRadius,
  passesFilter,
} from './KnowledgeGraph';

function node(partial: Partial<KnowledgeGraphNode> & { id: string }): KnowledgeGraphNode {
  return {
    name: partial.id,
    parent_id: null,
    ...partial,
  };
}

function edge(
  partial: Partial<KnowledgeGraphEdge> & {
    id: string;
    from_knowledge_id: string;
    to_knowledge_id: string;
  },
): KnowledgeGraphEdge {
  return {
    relation_type: 'related_to',
    weight: 1,
    ...partial,
  };
}

const NO_MISTAKES = new Map<string, number>();
const NO_DUE = new Map<string, NodeDueSummary>();

// A confident, high-evidence node defaults so band logic isn't gated by evidence
// unless a test sets evidence_count explicitly.
function confident(partial: Partial<KnowledgeGraphNode> & { id: string }): KnowledgeGraphNode {
  return node({ evidence_count: 5, ...partial });
}

describe('masteryBand (Fix B — mirrors MasteryBadge incl. evidence gate)', () => {
  it('evidence_count === 0 → untrained regardless of mastery', () => {
    expect(masteryBand(0.9, 0)).toBe('untrained');
    expect(masteryBand(null, 0)).toBe('untrained');
    expect(masteryBand(0.5, 0)).toBe('untrained');
  });

  it('evidence_count 1-2 → insufficient (the mastery=0.5 sentinel case)', () => {
    // The knowledge_mastery view emits 0.5 as a sentinel for low evidence.
    expect(masteryBand(0.5, 1)).toBe('insufficient');
    expect(masteryBand(0.5, 2)).toBe('insufficient');
    // High mastery but still <3 evidence is also insufficient.
    expect(masteryBand(0.95, 2)).toBe('insufficient');
  });

  it('evidence_count >= 3 → bands by mastery threshold', () => {
    expect(masteryBand(0.39, 3)).toBe('weak');
    expect(masteryBand(0.4, 3)).toBe('learning'); // 0.4 boundary inclusive of learning
    expect(masteryBand(0.69, 3)).toBe('learning');
    expect(masteryBand(0.7, 3)).toBe('mastered'); // 0.7 boundary inclusive of mastered
    expect(masteryBand(1, 5)).toBe('mastered');
  });

  it('null mastery with sufficient evidence → untrained', () => {
    expect(masteryBand(null, 5)).toBe('untrained');
    expect(masteryBand(undefined, 5)).toBe('untrained');
  });

  it('legacy threshold-only behavior when evidence_count omitted', () => {
    // No evidence arg → treat as sufficient (Number.POSITIVE_INFINITY), so the
    // mastery thresholds drive the band as before Fix B.
    expect(masteryBand(0.5)).toBe('learning');
    expect(masteryBand(0.3)).toBe('weak');
    expect(masteryBand(0.8)).toBe('mastered');
    expect(masteryBand(null)).toBe('untrained');
  });
});

describe('isWeakish', () => {
  it('weak / untrained / insufficient are all weakish', () => {
    expect(isWeakish(0.2, 5)).toBe(true); // weak
    expect(isWeakish(0.9, 0)).toBe(true); // untrained
    expect(isWeakish(0.5, 1)).toBe(true); // insufficient
    expect(isWeakish(null, 5)).toBe(true); // untrained (null mastery)
  });

  it('learning / mastered are not weakish', () => {
    expect(isWeakish(0.5, 5)).toBe(false); // learning
    expect(isWeakish(0.9, 5)).toBe(false); // mastered
  });
});

describe('distinctDomains', () => {
  it('dedupes, prefers effective_domain over domain, sorts zh-Hans', () => {
    const domains = distinctDomains([
      node({ id: 'a', effective_domain: '数学', domain: 'x' }),
      node({ id: 'b', effective_domain: null, domain: '物理' }),
      node({ id: 'c', effective_domain: '数学' }),
      node({ id: 'd', effective_domain: null, domain: null }),
    ]);
    expect(domains).toEqual(['数学', '物理'].sort((x, y) => x.localeCompare(y, 'zh-Hans-CN')));
    // No empty/null domain leaks in.
    expect(domains).not.toContain('');
  });

  it('returns empty array when no domains present', () => {
    expect(distinctDomains([node({ id: 'a' })])).toEqual([]);
  });
});

describe('passesFilter (composition)', () => {
  const all: FilterState = { domain: null, mastery: 'all', dueOnly: false };

  it('all filter passes everything', () => {
    expect(passesFilter(confident({ id: 'a', mastery: 0.1 }), all, NO_DUE)).toBe(true);
  });

  it('domain filter restricts by effective_domain (fallback to domain)', () => {
    const f: FilterState = { ...all, domain: '数学' };
    expect(passesFilter(node({ id: 'a', effective_domain: '数学' }), f, NO_DUE)).toBe(true);
    expect(passesFilter(node({ id: 'b', domain: '数学', effective_domain: null }), f, NO_DUE)).toBe(
      true,
    );
    expect(passesFilter(node({ id: 'c', effective_domain: '物理' }), f, NO_DUE)).toBe(false);
  });

  it('weak filter target includes weak + untrained + insufficient', () => {
    const f: FilterState = { ...all, mastery: 'weak' };
    expect(passesFilter(confident({ id: 'w', mastery: 0.2 }), f, NO_DUE)).toBe(true); // weak
    expect(passesFilter(node({ id: 'u', mastery: 0.9, evidence_count: 0 }), f, NO_DUE)).toBe(true); // untrained
    expect(passesFilter(node({ id: 'i', mastery: 0.5, evidence_count: 1 }), f, NO_DUE)).toBe(true); // insufficient
    expect(passesFilter(confident({ id: 'm', mastery: 0.9 }), f, NO_DUE)).toBe(false); // mastered
  });

  it('learning / mastered filters select only their band', () => {
    const learning: FilterState = { ...all, mastery: 'learning' };
    const mastered: FilterState = { ...all, mastery: 'mastered' };
    expect(passesFilter(confident({ id: 'l', mastery: 0.5 }), learning, NO_DUE)).toBe(true);
    expect(passesFilter(confident({ id: 'l', mastery: 0.5 }), mastered, NO_DUE)).toBe(false);
    expect(passesFilter(confident({ id: 'm', mastery: 0.9 }), mastered, NO_DUE)).toBe(true);
  });

  it('dueOnly composes with mastery (overdue > 0 required)', () => {
    const due = new Map<string, NodeDueSummary>([['a', { overdue: 2, due_soon: 0 }]]);
    const f: FilterState = { ...all, dueOnly: true };
    expect(passesFilter(confident({ id: 'a', mastery: 0.9 }), f, due)).toBe(true);
    expect(passesFilter(confident({ id: 'b', mastery: 0.9 }), f, due)).toBe(false); // no overdue
  });
});

describe('nodeRadius', () => {
  it('12 + min(20, mistakeCount*4)', () => {
    expect(nodeRadius(0)).toBe(12);
    expect(nodeRadius(1)).toBe(16);
    expect(nodeRadius(5)).toBe(32); // 12 + min(20, 20)
    expect(nodeRadius(100)).toBe(32); // capped at +20
  });
});

describe('buildElements (Slice 1a)', () => {
  const nodes = [
    node({ id: 'root', parent_id: null, mastery: 0.8, evidence_count: 5 }),
    node({ id: 'child', parent_id: 'root', mastery: 0.3, evidence_count: 5 }),
    node({ id: 'lonely', parent_id: 'missing-parent', mastery: 0.5, evidence_count: 1 }),
  ];

  it('emits one node element per node with band + diameter from mastery/mistakes', () => {
    const mistakes = new Map<string, number>([['root', 2]]);
    const els = buildElements(nodes, [], mistakes, NO_DUE);
    const nodeEls = els.filter((e) => e.group === 'nodes');
    expect(nodeEls).toHaveLength(3);

    const root = nodeEls.find((e) => e.data.id === 'root');
    expect(root?.data.band).toBe('mastered');
    expect(root?.data.diameter).toBe(nodeRadius(2) * 2); // 16*2 = 32

    const child = nodeEls.find((e) => e.data.id === 'child');
    expect(child?.data.band).toBe('weak');

    // low-evidence node → insufficient band (Fix B), not learning.
    const lonely = nodeEls.find((e) => e.data.id === 'lonely');
    expect(lonely?.data.band).toBe('insufficient');
  });

  it('builds a tree edge for a node whose parent exists', () => {
    const els = buildElements(nodes, [], NO_MISTAKES, NO_DUE);
    const treeEdges = els.filter((e) => e.group === 'edges' && e.data.kind === 'tree');
    expect(treeEdges).toHaveLength(1);
    expect(treeEdges[0].data).toMatchObject({ source: 'root', target: 'child', id: 'tree-child' });
  });

  it('skips a tree edge when the parent_id has no node (dangling endpoint)', () => {
    const els = buildElements(nodes, [], NO_MISTAKES, NO_DUE);
    const treeEdges = els.filter((e) => e.group === 'edges' && e.data.kind === 'tree');
    expect(treeEdges.find((e) => e.data.target === 'lonely')).toBeUndefined();
  });

  it('builds mesh edges with weight-driven width and skips dangling endpoints', () => {
    const edges = [
      edge({ id: 'm1', from_knowledge_id: 'root', to_knowledge_id: 'child', weight: 2 }),
      // dangling: target not in node set → skipped
      edge({ id: 'm2', from_knowledge_id: 'root', to_knowledge_id: 'ghost' }),
    ];
    const els = buildElements(nodes, edges, NO_MISTAKES, NO_DUE);
    const meshEdges = els.filter((e) => e.group === 'edges' && e.data.kind === 'mesh');
    expect(meshEdges).toHaveLength(1);
    expect(meshEdges[0].data.id).toBe('m1');
    expect(meshEdges[0].data.width).toBe(1 + 2 * 1.5); // 4
  });

  it('falls back unknown / experimental relation_type to related_to visual key', () => {
    const edges = [
      edge({
        id: 'mx',
        from_knowledge_id: 'root',
        to_knowledge_id: 'child',
        relation_type: 'experimental:co_occurs',
      }),
      edge({
        id: 'mp',
        from_knowledge_id: 'root',
        to_knowledge_id: 'child',
        relation_type: 'prerequisite',
      }),
    ];
    const els = buildElements(nodes, edges, NO_MISTAKES, NO_DUE);
    const mx = els.find((e) => e.data.id === 'mx');
    const mp = els.find((e) => e.data.id === 'mp');
    expect(mx?.data.relation).toBe('related_to'); // unknown → fallback
    expect(mp?.data.relation).toBe('prerequisite'); // known → preserved
  });

  it('adds the kg-due class + overdue data only when overdue > 0', () => {
    const due = new Map<string, NodeDueSummary>([
      ['root', { overdue: 3, due_soon: 1 }],
      ['child', { overdue: 0, due_soon: 2 }],
    ]);
    const els = buildElements(nodes, [], NO_MISTAKES, due);
    const root = els.find((e) => e.data.id === 'root');
    const child = els.find((e) => e.data.id === 'child');
    expect(root?.classes).toBe('kg-due');
    expect(root?.data.overdue).toBe(3);
    expect(child?.classes).toBeUndefined();
    expect(child?.data.due_soon).toBe(2);
  });
});

describe('buildProposedEdgeElements (Slice 3 — "AI 画布")', () => {
  function proposal(
    partial: Partial<KnowledgeEdgeProposal> & {
      id: string;
      from_knowledge_id: string;
      to_knowledge_id: string;
    },
  ): KnowledgeEdgeProposal {
    return {
      key: `${partial.from_knowledge_id}:${partial.to_knowledge_id}`,
      relation_type: 'related_to',
      ...partial,
    };
  }

  const visible = new Set(['a', 'b', 'c']);

  it('emits one proposed edge per proposal whose both endpoints are visible', () => {
    const els = buildProposedEdgeElements(
      [
        proposal({
          id: 'p1',
          from_knowledge_id: 'a',
          to_knowledge_id: 'b',
          relation_type: 'prerequisite',
        }),
        proposal({ id: 'p2', from_knowledge_id: 'b', to_knowledge_id: 'c' }),
      ],
      visible,
    );
    expect(els).toHaveLength(2);
    const p1 = els.find((e) => e.data.proposalId === 'p1');
    expect(p1?.data.kind).toBe('proposed');
    expect(p1?.data.source).toBe('a');
    expect(p1?.data.target).toBe('b');
    expect(p1?.data.relation).toBe('prerequisite');
    expect(p1?.classes).toBe('kg-proposed');
  });

  it('skips a proposal when either endpoint is not visible (filter/focus guard)', () => {
    const els = buildProposedEdgeElements(
      [
        // target 'z' not visible → skipped
        proposal({ id: 'p1', from_knowledge_id: 'a', to_knowledge_id: 'z' }),
        // source 'z' not visible → skipped
        proposal({ id: 'p2', from_knowledge_id: 'z', to_knowledge_id: 'b' }),
        // both visible → kept
        proposal({ id: 'p3', from_knowledge_id: 'a', to_knowledge_id: 'c' }),
      ],
      visible,
    );
    expect(els).toHaveLength(1);
    expect(els[0].data.proposalId).toBe('p3');
  });

  it('prefixes element ids with proposed-<key> so they never collide with edge/tree ids', () => {
    const els = buildProposedEdgeElements(
      [
        proposal({
          id: 'p1',
          key: 'subj:a:b:rel:actor',
          from_knowledge_id: 'a',
          to_knowledge_id: 'b',
        }),
      ],
      visible,
    );
    expect(els[0].data.id).toBe('proposed-subj:a:b:rel:actor');
  });

  it('falls back unknown / experimental relation_type to related_to visual key', () => {
    const els = buildProposedEdgeElements(
      [
        proposal({
          id: 'px',
          from_knowledge_id: 'a',
          to_knowledge_id: 'b',
          relation_type: 'experimental:co_occurs',
        }),
      ],
      visible,
    );
    expect(els[0].data.relation).toBe('related_to');
  });

  it('returns empty array when there are no proposals', () => {
    expect(buildProposedEdgeElements([], visible)).toEqual([]);
  });
});

describe('buildStylesheet (Slice 1a)', () => {
  // A token map with each name mapped to a recognisable literal.
  const tokens = Object.fromEntries(TOKEN_NAMES.map((n) => [n, `value(${n})`])) as TokenMap;

  // The sheet is a union of block shapes; every block buildStylesheet emits is a
  // { selector, style } pair, so narrow to that shape for assertion ergonomics.
  type StyleBlock = { selector?: string; style?: Record<string, unknown> };
  function styleOf(sheet: ReturnType<typeof buildStylesheet>, selector: string) {
    const block = (sheet as StyleBlock[]).find((s) => s.selector === selector);
    return block?.style;
  }

  it('keeps mesh edges above tree edges via z-index (mesh-over-tree)', () => {
    const sheet = buildStylesheet(tokens);
    const tree = styleOf(sheet, 'edge[kind = "tree"]');
    const mesh = styleOf(sheet, 'edge[kind = "mesh"]');
    expect(tree?.['z-index']).toBe(1);
    expect(mesh?.['z-index']).toBe(5);
    expect(mesh?.['z-index'] as number).toBeGreaterThan(tree?.['z-index'] as number);
    // z-index-compare must be manual on both so cytoscape honors edge ordering.
    expect(tree?.['z-index-compare']).toBe('manual');
    expect(mesh?.['z-index-compare']).toBe('manual');
  });

  it('emits a per-relation style for each RELATION_VISUAL entry with arrow/dash from the contract', () => {
    const sheet = buildStylesheet(tokens);
    for (const [relation, visual] of Object.entries(RELATION_VISUAL)) {
      const style = styleOf(sheet, `edge[kind = "mesh"][relation = "${relation}"]`);
      expect(style, `missing style for ${relation}`).toBeDefined();
      expect(style?.['line-color']).toBe(`value(${visual.token})`);
      expect(style?.['line-style']).toBe(visual.dashed ? 'dashed' : 'solid');
      expect(style?.['target-arrow-shape']).toBe(visual.arrow ? 'triangle' : 'none');
    }
  });

  it('has a distinct insufficient band fill (faint --ink-5 at reduced opacity)', () => {
    const sheet = buildStylesheet(tokens);
    const style = styleOf(sheet, 'node[band = "insufficient"]');
    expect(style?.['background-color']).toBe('value(--ink-5)');
    expect(style?.['background-opacity']).toBe(0.4);
  });

  it('proposed edges are dotted, faint, AI-marked, and sit just above mesh (Slice 3)', () => {
    const sheet = buildStylesheet(tokens);
    const proposed = styleOf(sheet, 'edge[kind = "proposed"]');
    expect(proposed?.['line-style']).toBe('dotted');
    expect(proposed?.opacity).toBe(0.5); // fainter than mesh's 0.72 → "tentative"
    expect(proposed?.['source-arrow-color']).toBe('value(--info)'); // AI tone marker
    expect(proposed?.['z-index']).toBe(6);
    // Above mesh (5) but visually subordinate via dotted/opacity.
    const mesh = styleOf(sheet, 'edge[kind = "mesh"]');
    expect(proposed?.['z-index'] as number).toBeGreaterThan(mesh?.['z-index'] as number);
  });

  it('emits a per-relation tint for each proposed relation (color reads the proposed KIND)', () => {
    const sheet = buildStylesheet(tokens);
    for (const [relation, visual] of Object.entries(RELATION_VISUAL)) {
      const style = styleOf(sheet, `edge[kind = "proposed"][relation = "${relation}"]`);
      expect(style, `missing proposed style for ${relation}`).toBeDefined();
      expect(style?.['line-color']).toBe(`value(${visual.token})`);
      // line-style is NOT overridden here — it inherits dotted from the base block.
      expect(style?.['line-style']).toBeUndefined();
    }
  });
});
