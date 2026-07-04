// YUK-561 S1 (revert-bracket §6.4) — θ̂ snapshot column-drift guard.
//
// The revert-bracket contract is that a θ̂ revert restores the FULL pre-attempt
// mastery_state row VERBATIM. That only holds if `ThetaRowSnapshot` (the snapshot
// `before` schema) captures EVERY column an attempt writes to mastery_state. This
// test pins the two in lock-step: it introspects the live `mastery_state` table and
// asserts every attempt-writable business column has a matching `ThetaRowSnapshot`
// field. When a future migration adds a column an attempt writes, this test goes RED
// until the author either (a) adds it to `ThetaRowSnapshot` (+ the state.ts capture +
// restore) so verbatim fidelity holds, or (b) adds it to NON_SNAPSHOT_COLUMNS below
// with a reason (an identity/audit/never-written-by-attempt column).
//
// Partition: imports `@/db/schema` (drizzle table metadata) → DB-tainted → db config.
// It does NOT open a connection — getTableColumns is pure metadata; no resetDb.

import { ThetaRowSnapshot } from '@/core/schema/event/state-snapshot';
import { mastery_state } from '@/db/schema';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

// Columns on mastery_state that a θ̂ attempt does NOT write (so they are NOT part of
// the verbatim snapshot). Each entry is a deliberate exclusion, not an oversight:
const NON_SNAPSHOT_COLUMNS = new Set<string>([
  // identity / keying
  'id',
  'subject_kind',
  'subject_id',
  // audit
  'updated_at',
  // soft-track placeholders — NOT written by updateThetaForAttempt (Wave2 recalibration
  // / A2-review paths only). When they gain an attempt write path, move them into the
  // snapshot (schema.ts documents both as inert this wave).
  'calibration_residual',
  'fluency_illusion_flag',
]);

describe('θ̂ snapshot column-drift guard (YUK-561 S1)', () => {
  it('every attempt-writable mastery_state column is captured by ThetaRowSnapshot', () => {
    const tableColumns = Object.keys(getTableColumns(mastery_state));
    const attemptWritable = tableColumns.filter((c) => !NON_SNAPSHOT_COLUMNS.has(c)).sort();
    const snapshotFields = Object.keys(ThetaRowSnapshot.shape).sort();

    // Bi-directional: no attempt column missing from the snapshot (verbatim would
    // silently lose it), and no snapshot field without a backing column (dead field).
    expect(snapshotFields).toEqual(attemptWritable);
  });
});
