// ADR-0034 — write-time structural consistency gate (topology layer).
//
// Pure graph checks over knowledge_edge writes — no DB, no LLM. Exercises the
// three topological predicates the ADR §2 mandates on the `prerequisite`
// (learning-order) relation:
//   ① cycle detection      — a prerequisite edge must not close a cycle → reject
//   ② direction contradiction — A prereq B AND B prereq A → reject
//   ③ transitive redundancy — A→…→C already reachable, direct A→C → warn
//
// The semantic gate (rubric-validator.ts) is orthogonal; this layer is pure
// topology and is unit-tested in isolation over in-memory edge snapshots.

import { describe, expect, it } from 'vitest';

import { type TopologyEdge, checkEdgeTopology } from './topology-gate';

function edge(from: string, to: string, relation_type = 'prerequisite'): TopologyEdge {
  return { from_knowledge_id: from, to_knowledge_id: to, relation_type };
}

describe('checkEdgeTopology — ① cycle detection (prerequisite)', () => {
  it('rejects a 3-node cycle: A→B→C exists, adding C→A closes the loop', () => {
    const existing = [edge('A', 'B'), edge('B', 'C')];
    const verdict = checkEdgeTopology(edge('C', 'A'), existing);
    expect(verdict.status).toBe('reject');
    if (verdict.status === 'reject') {
      expect(verdict.gate).toBe('cycle');
    }
  });

  it('rejects a longer cycle: A→B→C→D exists, adding D→A closes it', () => {
    const existing = [edge('A', 'B'), edge('B', 'C'), edge('C', 'D')];
    const verdict = checkEdgeTopology(edge('D', 'A'), existing);
    expect(verdict.status).toBe('reject');
    if (verdict.status === 'reject') {
      expect(verdict.gate).toBe('cycle');
    }
  });

  it('accepts a non-cyclic addition: A→B→C exists, adding C→D (no path D→C)', () => {
    const existing = [edge('A', 'B'), edge('B', 'C')];
    const verdict = checkEdgeTopology(edge('C', 'D'), existing);
    expect(verdict.status).toBe('ok');
  });

  it('accepts a DAG diamond merge: A→B, A→C exist, adding B→D and then C→D is fine', () => {
    const existing = [edge('A', 'B'), edge('A', 'C'), edge('B', 'D')];
    const verdict = checkEdgeTopology(edge('C', 'D'), existing);
    expect(verdict.status).toBe('ok');
  });
});

describe('checkEdgeTopology — ② direction contradiction', () => {
  it('rejects the inverse of an existing prerequisite edge (A→B exists, add B→A)', () => {
    const existing = [edge('A', 'B')];
    const verdict = checkEdgeTopology(edge('B', 'A'), existing);
    expect(verdict.status).toBe('reject');
    if (verdict.status === 'reject') {
      expect(verdict.gate).toBe('direction_contradiction');
    }
  });

  it('prefers the direction_contradiction gate over the generic cycle gate for the 2-node case', () => {
    const existing = [edge('A', 'B')];
    const verdict = checkEdgeTopology(edge('B', 'A'), existing);
    // A 2-node back-edge IS technically a cycle, but the ADR calls direction
    // contradiction out separately — the more specific gate must win.
    if (verdict.status === 'reject') {
      expect(verdict.gate).toBe('direction_contradiction');
    }
  });
});

describe('checkEdgeTopology — ③ transitive redundancy (warning, not reject)', () => {
  it('warns when A→B→C exists and a direct A→C is proposed', () => {
    const existing = [edge('A', 'B'), edge('B', 'C')];
    const verdict = checkEdgeTopology(edge('A', 'C'), existing);
    expect(verdict.status).toBe('warn');
    if (verdict.status === 'warn') {
      expect(verdict.gate).toBe('transitive_redundancy');
    }
  });

  it('warns on a longer transitive path A→B→C→D, direct A→D', () => {
    const existing = [edge('A', 'B'), edge('B', 'C'), edge('C', 'D')];
    const verdict = checkEdgeTopology(edge('A', 'D'), existing);
    expect(verdict.status).toBe('warn');
    if (verdict.status === 'warn') {
      expect(verdict.gate).toBe('transitive_redundancy');
    }
  });

  it('does NOT warn for a direct edge that has no alternative transitive path', () => {
    const existing = [edge('A', 'B')];
    const verdict = checkEdgeTopology(edge('A', 'C'), existing);
    expect(verdict.status).toBe('ok');
  });

  it('reject (cycle/direction) takes priority over a transitive warning', () => {
    // A→B→C exists. A direct C→A is BOTH a cycle and (no transitive A-path from
    // C to A here) — must reject, never downgrade to warn.
    const existing = [edge('A', 'B'), edge('B', 'C')];
    const verdict = checkEdgeTopology(edge('C', 'A'), existing);
    expect(verdict.status).toBe('reject');
  });
});

describe('checkEdgeTopology — relation scoping', () => {
  it('ignores non-prerequisite existing edges when checking a prerequisite candidate', () => {
    // A related_to B + B related_to A is NOT a prerequisite contradiction.
    const existing = [edge('A', 'B', 'related_to'), edge('B', 'A', 'related_to')];
    const verdict = checkEdgeTopology(edge('A', 'B'), existing);
    expect(verdict.status).toBe('ok');
  });

  it('returns ok for a non-prerequisite candidate (topology gate is prerequisite-scoped)', () => {
    // related_to is symmetric / non-ordering — cycles are meaningless. The ADR
    // scopes the cycle/direction checks to the learning-order relation only.
    const existing = [edge('A', 'B'), edge('B', 'C')];
    const verdict = checkEdgeTopology(edge('C', 'A', 'related_to'), existing);
    expect(verdict.status).toBe('ok');
  });

  it('ignores archived (excluded) edges — caller passes only live edges', () => {
    // Contract check: the function operates purely on the edges it is given. An
    // empty existing set can never produce a cycle/redundancy.
    const verdict = checkEdgeTopology(edge('A', 'B'), []);
    expect(verdict.status).toBe('ok');
  });
});

describe('checkEdgeTopology — self edge', () => {
  it('rejects a self-loop as a degenerate cycle', () => {
    const verdict = checkEdgeTopology(edge('A', 'A'), []);
    expect(verdict.status).toBe('reject');
    if (verdict.status === 'reject') {
      expect(verdict.gate).toBe('cycle');
    }
  });
});
