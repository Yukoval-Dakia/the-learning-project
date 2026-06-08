// Wave 7 T-KG (YUK-142) — unit tests for the rendering-agnostic pure functions
// behind the KnowledgeGraph primitive. After the YUK-297 SVG rewrite the
// cytoscape-shaped builders (buildElements / buildStylesheet /
// buildProposedEdgeElements) are gone — their layout/visual behavior now lives in
// the SVG render layer (KnowledgeGraph.render.test.tsx) + the layout engine
// (knowledge-graph/layout.test.ts). What remains here are the pure domain
// helpers that are independent of how the graph is drawn:
//
//   Slice 1b + Fix B — masteryBand / passesFilter / isWeakish / distinctDomains
//     band thresholds incl. the insufficient band, boundary values
//     0.4 / 0.7 / null / the 0.5 low-evidence sentinel, and filter composition.
//   masteryTone — mastery → design 3-tone (good/hard/again), the disc fill + arc.
//   relationVisualKey / RELATION_VISUAL — the relation visual contract
//     (unknown/experimental → related_to fallback).

import { describe, expect, it } from 'vitest';
import {
  type FilterState,
  type KnowledgeGraphNode,
  type NodeDueSummary,
  RELATION_VISUAL,
  distinctDomains,
  isInlineExpandable,
  isWeakish,
  masteryBand,
  masteryTone,
  passesFilter,
  relationVisualKey,
} from './KnowledgeGraph';

function node(partial: Partial<KnowledgeGraphNode> & { id: string }): KnowledgeGraphNode {
  return {
    name: partial.id,
    parent_id: null,
    ...partial,
  };
}

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
    expect(masteryBand(0.5, 1)).toBe('insufficient');
    expect(masteryBand(0.5, 2)).toBe('insufficient');
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

describe('masteryTone (design 3-tone — disc fill / arc color)', () => {
  it('mastery → good (>=0.7) / hard (>=0.4) / again (<0.4)', () => {
    expect(masteryTone(0.9)).toBe('good');
    expect(masteryTone(0.7)).toBe('good'); // 0.7 boundary inclusive of good
    expect(masteryTone(0.69)).toBe('hard');
    expect(masteryTone(0.4)).toBe('hard'); // 0.4 boundary inclusive of hard
    expect(masteryTone(0.39)).toBe('again');
    expect(masteryTone(0)).toBe('again');
  });

  it('null / undefined mastery → again (never practiced collapses to 0)', () => {
    expect(masteryTone(null)).toBe('again');
    expect(masteryTone(undefined)).toBe('again');
  });
});

describe('relationVisualKey + RELATION_VISUAL contract', () => {
  it('keeps the 5 typed relations with their production token / arrow / dash', () => {
    // Token correction (YUK-297 §⑤): applied_in→--info, derived_from→--ink-5,
    // contrasts_with→--contrasts (NOT the design mock's amber/good tones).
    expect(RELATION_VISUAL.prerequisite).toEqual({ token: '--coral', arrow: true, dashed: false });
    expect(RELATION_VISUAL.applied_in).toEqual({ token: '--info', arrow: true, dashed: false });
    expect(RELATION_VISUAL.derived_from).toEqual({ token: '--ink-5', arrow: true, dashed: false });
    expect(RELATION_VISUAL.contrasts_with).toEqual({
      token: '--contrasts',
      arrow: false,
      dashed: false,
    });
    expect(RELATION_VISUAL.related_to).toEqual({ token: '--ink-4', arrow: false, dashed: true });
  });

  it('maps known relations to themselves and unknown/experimental → related_to', () => {
    expect(relationVisualKey('prerequisite')).toBe('prerequisite');
    expect(relationVisualKey('applied_in')).toBe('applied_in');
    expect(relationVisualKey('experimental:co_occurs')).toBe('related_to');
    expect(relationVisualKey('totally_unknown')).toBe('related_to');
  });
});

describe('isInlineExpandable (deep + wide cap — owner 2026-06-08)', () => {
  it('no children → never expandable', () => {
    expect(isInlineExpandable(0, 0)).toBe(false);
    expect(isInlineExpandable(3, 0)).toBe(false);
  });

  it('a top-level root (depth 0) is expandable at any width', () => {
    expect(isInlineExpandable(0, 5)).toBe(true);
    expect(isInlineExpandable(0, 200)).toBe(true);
  });

  it('a 2nd-level-or-deeper node is capped above 40 children', () => {
    expect(isInlineExpandable(1, 40)).toBe(true); // 40 is OK
    expect(isInlineExpandable(1, 41)).toBe(false); // 41 floods → not inline
    expect(isInlineExpandable(2, 41)).toBe(false);
    expect(isInlineExpandable(5, 9999)).toBe(false);
  });
});
