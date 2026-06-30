// YUK-531 (A5 S4 / ADR-0034 #45) — heterogeneous misconception_edge topology gate.
//
// Pure cross-kind structural checks — no DB, no LLM. Exercises the three predicates
// the parallel gate enforces (the prerequisite-DAG cycle/direction/transitive checks
// do NOT apply to cross-kind, unordered misconception edges):
//   ① endpoint-kind validity — from MUST be misconception; relation pins target kind
//   ② self-loop              — same-entity edge → reject
//   ③ symmetric redundancy   — confusable_with inverse already present → warn

import { describe, expect, it } from 'vitest';

import {
  type MisconceptionTopologyEdge,
  checkMisconceptionEdgeTopology,
} from './misconception-topology-gate';

function edge(
  from_kind: string,
  from_id: string,
  to_kind: string,
  to_id: string,
  relation_type: string,
): MisconceptionTopologyEdge {
  return { from_kind, from_id, to_kind, to_id, relation_type };
}

describe('checkMisconceptionEdgeTopology — ① endpoint-kind validity', () => {
  it('accepts caused_by misconception → knowledge', () => {
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'm1', 'knowledge', 'k1', 'caused_by'),
      [],
    );
    expect(v.status).toBe('ok');
  });

  it('accepts observed_in misconception → event', () => {
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'm1', 'event', 'e1', 'observed_in'),
      [],
    );
    expect(v.status).toBe('ok');
  });

  it('accepts confusable_with misconception → misconception and → knowledge', () => {
    expect(
      checkMisconceptionEdgeTopology(
        edge('misconception', 'm1', 'misconception', 'm2', 'confusable_with'),
        [],
      ).status,
    ).toBe('ok');
    expect(
      checkMisconceptionEdgeTopology(
        edge('misconception', 'm1', 'knowledge', 'k1', 'confusable_with'),
        [],
      ).status,
    ).toBe('ok');
  });

  it('rejects a non-misconception origin (from_kind invariant)', () => {
    const v = checkMisconceptionEdgeTopology(
      edge('knowledge', 'k1', 'knowledge', 'k2', 'caused_by'),
      [],
    );
    expect(v.status).toBe('reject');
    if (v.status === 'reject') expect(v.gate).toBe('endpoint_kind');
  });

  it('rejects caused_by whose target is not a KC (→ event)', () => {
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'm1', 'event', 'e1', 'caused_by'),
      [],
    );
    expect(v.status).toBe('reject');
    if (v.status === 'reject') expect(v.gate).toBe('endpoint_kind');
  });

  it('rejects observed_in whose target is not an event (→ knowledge)', () => {
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'm1', 'knowledge', 'k1', 'observed_in'),
      [],
    );
    expect(v.status).toBe('reject');
    if (v.status === 'reject') expect(v.gate).toBe('endpoint_kind');
  });

  it('rejects confusable_with whose target is an event', () => {
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'm1', 'event', 'e1', 'confusable_with'),
      [],
    );
    expect(v.status).toBe('reject');
    if (v.status === 'reject') expect(v.gate).toBe('endpoint_kind');
  });

  it('experimental:* pins from_kind but leaves to_kind free', () => {
    // any target kind is accepted for an experimental relation, as long as from is a misconception
    expect(
      checkMisconceptionEdgeTopology(
        edge('misconception', 'm1', 'event', 'e1', 'experimental:novel'),
        [],
      ).status,
    ).toBe('ok');
    expect(
      checkMisconceptionEdgeTopology(
        edge('misconception', 'm1', 'knowledge', 'k1', 'experimental:novel'),
        [],
      ).status,
    ).toBe('ok');
    // but from_kind is still pinned
    const bad = checkMisconceptionEdgeTopology(
      edge('knowledge', 'k1', 'knowledge', 'k2', 'experimental:novel'),
      [],
    );
    expect(bad.status).toBe('reject');
    if (bad.status === 'reject') expect(bad.gate).toBe('endpoint_kind');
  });
});

describe('checkMisconceptionEdgeTopology — ② self-loop', () => {
  it('rejects a confusable_with edge to the same misconception (same id + kind)', () => {
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'm1', 'misconception', 'm1', 'confusable_with'),
      [],
    );
    expect(v.status).toBe('reject');
    if (v.status === 'reject') expect(v.gate).toBe('self_loop');
  });

  it('does NOT treat same id across different kinds as a self-loop', () => {
    // caused_by misconception "x" → knowledge "x": different namespaces, not a self-loop
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'x', 'knowledge', 'x', 'caused_by'),
      [],
    );
    expect(v.status).toBe('ok');
  });
});

describe('checkMisconceptionEdgeTopology — ③ symmetric redundancy (confusable_with)', () => {
  it('warns when the inverse confusable_with edge already exists', () => {
    const existing = [edge('misconception', 'm2', 'misconception', 'm1', 'confusable_with')];
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'm1', 'misconception', 'm2', 'confusable_with'),
      existing,
    );
    expect(v.status).toBe('warn');
    if (v.status === 'warn') expect(v.gate).toBe('symmetric_redundancy');
  });

  it('accepts confusable_with when no inverse exists', () => {
    const existing = [edge('misconception', 'm1', 'misconception', 'm3', 'confusable_with')];
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'm1', 'misconception', 'm2', 'confusable_with'),
      existing,
    );
    expect(v.status).toBe('ok');
  });

  it('does not flag caused_by as symmetric (different relation, no inverse semantics)', () => {
    const existing = [edge('misconception', 'm1', 'knowledge', 'k1', 'caused_by')];
    // a second misconception causing the same KC is fine; caused_by is not symmetric
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'm2', 'knowledge', 'k1', 'caused_by'),
      existing,
    );
    expect(v.status).toBe('ok');
  });

  it('reject (self-loop / endpoint) takes priority over a symmetric-redundancy warn', () => {
    // self-loop confusable_with with an irrelevant existing inverse → still reject self_loop
    const existing = [edge('misconception', 'm1', 'misconception', 'm1', 'confusable_with')];
    const v = checkMisconceptionEdgeTopology(
      edge('misconception', 'm1', 'misconception', 'm1', 'confusable_with'),
      existing,
    );
    expect(v.status).toBe('reject');
    if (v.status === 'reject') expect(v.gate).toBe('self_loop');
  });
});
