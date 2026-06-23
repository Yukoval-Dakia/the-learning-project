// YUK-471 Wave 1 PR-A1 — knowledge_edge fold reducer (UNIT, no DB).
//
// These tests pin the PURE fold contract documented in knowledge_edge.ts:
//   - generate (create) → row with archived_at=null
//   - generate (archive) → row with archived_at stamped
//   - experimental:genesis → seed row (payload.row byte for byte)
//   - order-stability (created_at asc, id asc — the caller pre-sorts)
//   - unknown edge → null
//   - ADR-0034 topology at fold-apply: prerequisite REJECT (cycle) throws,
//     WARN proceeds, non-prerequisite is passthrough (no topology check)
//
// No DB, no IO. The reducer is pure: liveMesh (the live-edge topology fixture)
// is PASSED IN.

import type { KnowledgeEdgeRowSnapshotT } from '@/core/schema/event/genesis';
import { describe, expect, it } from 'vitest';
import type { FoldEvent } from './fold-event';
import { foldKnowledgeEdge } from './knowledge_edge';

// ---------- helpers ----------

const t0 = '2026-01-01T00:00:00.000Z';
const t1 = '2026-02-01T00:00:00.000Z';
const t2 = '2026-03-01T00:00:00.000Z';

/** A generate-CREATE event for an edge, payload mirrors actions.ts:509-516. */
function generateCreateEvent(
  edgeId: string,
  over: Partial<FoldEvent> & { payload?: Record<string, unknown> } = {},
): FoldEvent {
  const base: FoldEvent = {
    id: 'gen-1',
    created_at: new Date(t0),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'generate',
    subject_kind: 'knowledge_edge',
    subject_id: edgeId,
    outcome: 'success',
    caused_by_event_id: 'propose-1',
    payload: {
      from_knowledge_id: 'kc-A',
      to_knowledge_id: 'kc-B',
      relation_type: 'prerequisite',
      weight: 1,
      reasoning: 'A is a prerequisite of B',
      propose_event_id: 'propose-1',
      ...(over.payload ?? {}),
    },
  };
  // Drop payload from `over` (already merged above) before overlaying the rest.
  const { payload: _payloadOver, ...restOver } = over;
  void _payloadOver;
  return { ...base, ...restOver };
}

/** A generate-ARCHIVE event for an edge, payload mirrors actions.ts:414-422. */
function generateArchiveEvent(edgeId: string, over: Partial<FoldEvent> = {}): FoldEvent {
  const base: FoldEvent = {
    id: 'gen-archive-1',
    created_at: new Date(t2),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'generate',
    subject_kind: 'knowledge_edge',
    subject_id: edgeId,
    outcome: 'success',
    caused_by_event_id: 'propose-archive-1',
    payload: {
      edge_op: 'archive',
      archive_edge_id: edgeId,
      from_knowledge_id: 'kc-A',
      to_knowledge_id: 'kc-B',
      relation_type: 'prerequisite',
      reasoning: '',
      propose_event_id: 'propose-archive-1',
    },
  };
  return { ...base, ...over };
}

describe('foldKnowledgeEdge', () => {
  // ---------- CREATE ----------

  it('generate (create) projects a live edge row with archived_at=null', () => {
    const row = foldKnowledgeEdge('edge-1', [generateCreateEvent('edge-1')], []);
    expect(row).not.toBeNull();
    expect((row as KnowledgeEdgeRowSnapshotT).id).toBe('edge-1');
    expect((row as KnowledgeEdgeRowSnapshotT).from_knowledge_id).toBe('kc-A');
    expect((row as KnowledgeEdgeRowSnapshotT).to_knowledge_id).toBe('kc-B');
    expect((row as KnowledgeEdgeRowSnapshotT).relation_type).toBe('prerequisite');
    expect((row as KnowledgeEdgeRowSnapshotT).weight).toBe(1);
    expect((row as KnowledgeEdgeRowSnapshotT).reasoning).toBe('A is a prerequisite of B');
    expect((row as KnowledgeEdgeRowSnapshotT).archived_at).toBeNull();
    // created_by reconstructed from the event envelope + propose_event_id provenance
    expect((row as KnowledgeEdgeRowSnapshotT).created_by).toEqual({
      actor_kind: 'user',
      actor_ref: 'self',
      propose_event_id: 'propose-1',
    });
    // created_at comes from the event row's own created_at (same-tx write, actions.ts:498/501)
    expect((row as KnowledgeEdgeRowSnapshotT).created_at).toEqual(new Date(t0));
  });

  it('generate (create) carries the payload weight/relation_type overrides', () => {
    const row = foldKnowledgeEdge(
      'edge-2',
      [
        generateCreateEvent('edge-2', {
          payload: {
            from_knowledge_id: 'kc-X',
            to_knowledge_id: 'kc-Y',
            relation_type: 'related_to',
            weight: 0.7,
            reasoning: '',
            propose_event_id: 'p-2',
          },
        }),
      ],
      [],
    );
    expect((row as KnowledgeEdgeRowSnapshotT).relation_type).toBe('related_to');
    expect((row as KnowledgeEdgeRowSnapshotT).weight).toBe(0.7);
  });

  it("generate (create) projects reasoning='' (absent) as NULL on the row", () => {
    // The generate-event payload encodes absent reasoning as '' (actions.ts:512)
    // while the ROW stores null (actions.ts:496). The fold uses `|| null` to recover
    // the absent case — so an empty-string reasoning must project to null, matching
    // the row. (HIGH regression: prior `?? null` left '' as '' and diverged.)
    const row = foldKnowledgeEdge(
      'edge-empty-reason',
      [
        generateCreateEvent('edge-empty-reason', {
          payload: {
            from_knowledge_id: 'kc-A',
            to_knowledge_id: 'kc-B',
            relation_type: 'prerequisite',
            weight: 1,
            reasoning: '',
            propose_event_id: 'p-empty',
          },
        }),
      ],
      [],
    );
    expect((row as KnowledgeEdgeRowSnapshotT).reasoning).toBeNull();
  });

  // ---------- ARCHIVE ----------

  it('generate (archive) stamps archived_at on an existing live edge', () => {
    const row = foldKnowledgeEdge(
      'edge-1',
      [
        generateCreateEvent('edge-1'),
        generateArchiveEvent('edge-1', { id: 'gen-2', created_at: new Date(t2) }),
      ],
      [],
    );
    expect(row).not.toBeNull();
    expect((row as KnowledgeEdgeRowSnapshotT).archived_at).not.toBeNull();
    // archived_at comes from the archive event row's created_at
    expect((row as KnowledgeEdgeRowSnapshotT).archived_at).toEqual(new Date(t2));
    // row created_at is still the CREATE event's timestamp
    expect((row as KnowledgeEdgeRowSnapshotT).created_at).toEqual(new Date(t0));
  });

  it('archive on unknown edge (no prior create) yields archived_at without a create row', () => {
    // An archive event with no preceding create — the edge existed pre-W1 (genesis
    // would normally seed it). The archive still stamps archived_at; created_at
    // falls back to the archive event's own created_at (best-effort).
    const row = foldKnowledgeEdge('edge-x', [generateArchiveEvent('edge-x')], []);
    expect(row).not.toBeNull();
    expect((row as KnowledgeEdgeRowSnapshotT).archived_at).toEqual(new Date(t2));
  });

  // ---------- GENESIS ----------

  it('experimental:genesis seeds the row byte-for-byte from payload.row', () => {
    const seedRow: KnowledgeEdgeRowSnapshotT = {
      id: 'edge-seed',
      from_knowledge_id: 'kc-S',
      to_knowledge_id: 'kc-T',
      relation_type: 'related_to',
      weight: 1,
      created_by: { actor_kind: 'system', actor_ref: 'seed' },
      reasoning: 'pre-W1 seed',
      created_at: new Date(t0),
      archived_at: null,
    };
    const genesisEvent: FoldEvent = {
      id: 'genesis-1',
      created_at: new Date(t0),
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      action: 'experimental:genesis',
      subject_kind: 'knowledge_edge',
      subject_id: 'edge-seed',
      outcome: 'success',
      caused_by_event_id: null,
      payload: { row: seedRow },
    };
    const row = foldKnowledgeEdge('edge-seed', [genesisEvent], []);
    expect(row).toEqual(seedRow);
  });

  it('skips a MALFORMED genesis seed (safeParse guard) — row stays null', () => {
    // A genesis seed whose payload.row is missing a required field (here
    // from_knowledge_id) must NOT corrupt the projection: the reducer safeParses
    // through KnowledgeEdgeRowSnapshot, warns, and skips → row stays null (prior
    // state). Proves the blind-cast was replaced by a validated parse.
    const malformedRow = {
      id: 'edge-bad',
      // from_knowledge_id intentionally missing
      to_knowledge_id: 'kc-T',
      relation_type: 'related_to',
      weight: 1,
      created_by: { actor_kind: 'system', actor_ref: 'seed' },
      reasoning: null,
      created_at: t0,
      archived_at: null,
    };
    const genesisEvent: FoldEvent = {
      id: 'genesis-bad',
      created_at: new Date(t0),
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      action: 'experimental:genesis',
      subject_kind: 'knowledge_edge',
      subject_id: 'edge-bad',
      outcome: 'success',
      caused_by_event_id: null,
      payload: { row: malformedRow },
    };
    const row = foldKnowledgeEdge('edge-bad', [genesisEvent], []);
    expect(row).toBeNull();
  });

  // ---------- ORDER STABILITY ----------

  it('folds events in given order (caller pre-sorts by created_at asc, id asc)', () => {
    // Three events out of chronological order in the array — the CALLER is
    // responsible for pre-sorting (mirrors getCorrectionStatuses' orderBy).
    // Here we pass them already sorted to confirm the reducer applies them
    // left-to-right: create → archive.
    const sorted = [
      generateCreateEvent('edge-1', { id: 'a', created_at: new Date(t0) }),
      generateArchiveEvent('edge-1', { id: 'b', created_at: new Date(t1) }),
    ];
    const row = foldKnowledgeEdge('edge-1', sorted, []);
    expect((row as KnowledgeEdgeRowSnapshotT).archived_at).toEqual(new Date(t1));
  });

  it('a later create following an archive re-creates a live row (idempotent re-fold)', () => {
    // create (live) → archive → create again (live). Final state is live.
    const events = [
      generateCreateEvent('edge-1', { id: 'a', created_at: new Date(t0) }),
      generateArchiveEvent('edge-1', { id: 'b', created_at: new Date(t1) }),
      generateCreateEvent('edge-1', { id: 'c', created_at: new Date(t2) }),
    ];
    const row = foldKnowledgeEdge('edge-1', events, []);
    expect((row as KnowledgeEdgeRowSnapshotT).archived_at).toBeNull();
    expect((row as KnowledgeEdgeRowSnapshotT).created_at).toEqual(new Date(t2));
  });

  // ---------- UNKNOWN EDGE ----------

  it('returns null for an unknown edge (no matching events)', () => {
    const row = foldKnowledgeEdge('edge-missing', [generateCreateEvent('edge-1')], []);
    expect(row).toBeNull();
  });

  it('returns null when events list is empty', () => {
    const row = foldKnowledgeEdge('edge-1', [], []);
    expect(row).toBeNull();
  });

  it('ignores events whose subject_id does not match edgeId', () => {
    const row = foldKnowledgeEdge('edge-target', [generateCreateEvent('edge-other')], []);
    expect(row).toBeNull();
  });

  // ---------- ADR-0034 topology at fold-apply ----------

  it('THROWS when a create adds a LIVE prerequisite edge that closes a cycle (reject verdict)', () => {
    // liveMesh already has kc-B → kc-A (so candidate kc-A → kc-B is a direction
    // contradiction / 2-node cycle — checkEdgeTopology returns reject).
    const liveMesh: KnowledgeEdgeRowSnapshotT[] = [
      {
        id: 'edge-live-BA',
        from_knowledge_id: 'kc-B',
        to_knowledge_id: 'kc-A',
        relation_type: 'prerequisite',
        weight: 1,
        created_by: { actor_kind: 'system', actor_ref: 'seed' },
        reasoning: null,
        created_at: new Date(t0),
        archived_at: null,
      },
    ];
    // candidate kc-A → kc-B reverses the live kc-B → kc-A → reject → THROW.
    expect(() =>
      foldKnowledgeEdge('edge-cycle', [generateCreateEvent('edge-cycle')], liveMesh),
    ).toThrow();
  });

  it('PROCEEDS on a topology WARN (transitive redundancy) — does not throw', () => {
    // liveMesh has kc-A → kc-B → kc-C. Candidate kc-A → kc-C is a direct edge
    // duplicating a transitive path → warn → proceed (no throw, row projected).
    const liveMesh: KnowledgeEdgeRowSnapshotT[] = [
      {
        id: 'e-AB',
        from_knowledge_id: 'kc-A',
        to_knowledge_id: 'kc-B',
        relation_type: 'prerequisite',
        weight: 1,
        created_by: { actor_kind: 'system', actor_ref: 'seed' },
        reasoning: null,
        created_at: new Date(t0),
        archived_at: null,
      },
      {
        id: 'e-BC',
        from_knowledge_id: 'kc-B',
        to_knowledge_id: 'kc-C',
        relation_type: 'prerequisite',
        weight: 1,
        created_by: { actor_kind: 'system', actor_ref: 'seed' },
        reasoning: null,
        created_at: new Date(t0),
        archived_at: null,
      },
    ];
    const warnCandidate = generateCreateEvent('edge-AC', {
      payload: {
        from_knowledge_id: 'kc-A',
        to_knowledge_id: 'kc-C',
        relation_type: 'prerequisite',
        weight: 1,
        reasoning: '',
        propose_event_id: 'p-AC',
      },
    });
    const row = foldKnowledgeEdge('edge-AC', [warnCandidate], liveMesh);
    expect(row).not.toBeNull();
    expect((row as KnowledgeEdgeRowSnapshotT).id).toBe('edge-AC');
  });

  it('does NOT run topology check on a non-prerequisite edge (passes even if structurally cyclic)', () => {
    // related_to is symmetric/non-ordering — topology gate is out of scope.
    // Even a self-referential related_to edge must pass (no throw).
    const selfRel = generateCreateEvent('edge-self-rel', {
      payload: {
        from_knowledge_id: 'kc-A',
        to_knowledge_id: 'kc-A', // self-loop, but non-prerequisite
        relation_type: 'related_to',
        weight: 1,
        reasoning: '',
        propose_event_id: 'p-self',
      },
    });
    const row = foldKnowledgeEdge('edge-self-rel', [selfRel], []);
    expect(row).not.toBeNull();
    expect((row as KnowledgeEdgeRowSnapshotT).from_knowledge_id).toBe('kc-A');
  });

  it('PASSTHROUGH on archive events (no topology check even for prerequisite edges)', () => {
    // Archiving a prerequisite edge never re-runs topology (it removes an edge,
    // it cannot close a cycle). Build a live edge then archive it with a liveMesh
    // that would reject a create — the archive must still succeed.
    const liveMesh: KnowledgeEdgeRowSnapshotT[] = [
      {
        id: 'edge-1',
        from_knowledge_id: 'kc-B',
        to_knowledge_id: 'kc-A',
        relation_type: 'prerequisite',
        weight: 1,
        created_by: { actor_kind: 'system', actor_ref: 'seed' },
        reasoning: null,
        created_at: new Date(t0),
        archived_at: null,
      },
    ];
    const row = foldKnowledgeEdge(
      'edge-1',
      [generateArchiveEvent('edge-1', { id: 'g2', created_at: new Date(t1) })],
      liveMesh,
    );
    expect(row).not.toBeNull();
    expect((row as KnowledgeEdgeRowSnapshotT).archived_at).toEqual(new Date(t1));
  });

  it('does NOT run topology check on a prerequisite edge that is ALREADY archived (genesis seed archived_at != null)', () => {
    // Topology only gates ADDING a LIVE prerequisite edge. A genesis seed that is
    // already archived does not enter the live graph → no topology check.
    const archivedSeed: KnowledgeEdgeRowSnapshotT = {
      id: 'edge-archived-seed',
      from_knowledge_id: 'kc-A',
      to_knowledge_id: 'kc-A', // would be a self-loop reject if checked
      relation_type: 'prerequisite',
      weight: 1,
      created_by: { actor_kind: 'system', actor_ref: 'seed' },
      reasoning: null,
      created_at: new Date(t0),
      archived_at: new Date(t1), // already archived → not live → no topology check
    };
    const genesisEvent: FoldEvent = {
      id: 'genesis-arch',
      created_at: new Date(t0),
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      action: 'experimental:genesis',
      subject_kind: 'knowledge_edge',
      subject_id: 'edge-archived-seed',
      outcome: 'success',
      caused_by_event_id: null,
      payload: { row: archivedSeed },
    };
    const row = foldKnowledgeEdge('edge-archived-seed', [genesisEvent], []);
    expect(row).toEqual(archivedSeed);
  });
});
