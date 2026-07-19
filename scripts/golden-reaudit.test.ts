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
