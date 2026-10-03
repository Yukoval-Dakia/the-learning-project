// YUK-549 (review round-2) — pure (no-DB) unit for golden-reaudit's corrupted-kind guard. Runs in the
// unit car via the `scripts/**/*.test.ts` convention (reauditGolden folds in memory; no DB touched).

import { describe, expect, it } from 'vitest';

import type { GoldenSnapshot } from './capture-golden';
import { reauditGolden } from './golden-reaudit';

describe('reauditGolden — corrupted-kind guard (round-2)', () => {
  it('throws a clear error naming the unknown kind, not an opaque "fold is not a function"', () => {
    // golden.kind is JSON.parse + an `as` cast, so a corrupted / newer-schema golden can carry a kind
    // absent from PROJECTION_FOLDS. The reaudit must fail loudly (naming the kind), not crash mid-fold
    // when `PROJECTION_FOLDS[kind]` comes back undefined.
    const corrupted: GoldenSnapshot = {
      kind: 'bogus_kind' as GoldenSnapshot['kind'],
      capturedAt: '2026-06-01T00:00:00.000Z',
      rowCount: 1,
      rows: { x: { id: 'x' } },
      events: [],
    };
    expect(() => reauditGolden(corrupted)).toThrow(/unknown ProjectionKind 'bogus_kind'/);
  });
});

describe('reauditGolden — live edge mesh boundary', () => {
  const edge = {
    id: 'edge_geometry',
    from_knowledge_id: 'kc_triangle',
    to_knowledge_id: 'kc_similarity',
    relation_type: 'prerequisite',
    weight: 0.8,
    created_by: { kind: 'system', trace: { source: 'retained-golden' } },
    reasoning: '相似三角形的判断依赖对应角与边的关系。',
    created_at: new Date('2026-09-24T10:00:00Z'),
    archived_at: null,
  };

  function snapshot(row: Record<string, unknown>): GoldenSnapshot {
    return {
      kind: 'knowledge_edge',
      capturedAt: '2026-09-24T11:00:00Z',
      rowCount: 1,
      rows: { edge_geometry: row },
      events: [],
    };
  }

  it('keeps a valid mesh intact and still reports missing event evidence as drift', () => {
    const golden = snapshot(edge);
    const before = structuredClone(golden);
    const result = reauditGolden(golden);
    expect(result.checked).toBe(1);
    expect(result.drifted.map((row) => row.id)).toEqual(['edge_geometry']);
    expect(golden).toEqual(before);
  });

  it.each(['heavy', Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects malformed live-edge weight %s before folding the mesh',
    (weight) => {
      expect(() => reauditGolden(snapshot({ ...edge, weight }))).toThrow(/weight/);
    },
  );

  it('keeps archived rows outside the live topology mesh', () => {
    const result = reauditGolden(
      snapshot({ ...edge, weight: 'legacy', archived_at: new Date('2026-09-24T10:30:00Z') }),
    );
    expect(result.checked).toBe(1);
    expect(result.drifted).toHaveLength(1);
  });
});
