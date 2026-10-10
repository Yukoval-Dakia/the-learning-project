// YUK-471 Wave 0 — restore-snapshot primitive db tests (plan §4 group D, tests 14-18).
//
// The oracle for `after` is ALWAYS the live `mastery_state` / `material_fsrs_state`
// row read directly from the DB — NOT the snapshot payload (tautology trap, plan §6.8).
// The oracle for `before` is the seeded value we wrote before invoking restore.
//
// These tests MUST be db-config (they import tests/helpers/db + drizzle + resetDb).

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  StateSnapshotExperimentalT,
  ThetaRowSnapshotT,
} from '@/core/schema/event/state-snapshot';
import { GRID_POINTS } from '@/core/theta-grid'; // YUK-561 FIX-3 — grid vector length
import type { Tx } from '@/db/client';
import { db as rootDb } from '@/db/client';
import { mastery_state } from '@/db/schema';
import { upsertMasteryState } from '@/server/mastery/state';
import { restoreStateSnapshot } from '@/server/revert/restore-snapshot';

import { resetDb, testDb } from '../helpers/db';

// Build a StateSnapshotExperimental payload around the snapshot arrays.
function snapshotPayload(
  thetaSnapshots: StateSnapshotExperimentalT['payload']['theta_snapshots'],
  fsrsSnapshots: StateSnapshotExperimentalT['payload']['fsrs_snapshots'],
): StateSnapshotExperimentalT['payload'] {
  return {
    attempt_event_id: 'evt_attempt_test',
    theta_snapshots: thetaSnapshots,
    fsrs_snapshots: fsrsSnapshots,
  };
}

// Read a mastery_state theta_hat directly from DB (independent oracle).
async function readTheta(subjectId: string): Promise<number | null> {
  const rows = await testDb()
    .select({ theta: mastery_state.theta_hat })
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, subjectId)),
    )
    .limit(1);
  return rows.length === 0 ? null : rows[0].theta;
}

// YUK-561 S1 — read the FULL mastery_state row (verbatim-restore oracle).
async function readMasteryRow(subjectId: string) {
  const rows = await testDb()
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, subjectId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

// YUK-561 S1 — build a rich ThetaRowSnapshot `before` (the new verbatim shape).
function richTheta(over: Partial<ThetaRowSnapshotT> = {}): ThetaRowSnapshotT {
  return {
    theta_hat: 1.25,
    evidence_count: 3,
    success_count: 2,
    fail_count: 1,
    theta_precision: 4.5,
    last_theta_delta: 0.3,
    last_outcome_at: new Date('2026-06-01T00:00:00Z'),
    rt_correct_ms: { samples: [1200, 900] },
    theta_grid_json: null,
    ...over,
  };
}

describe('restoreStateSnapshot (YUK-471 Wave 0 restore primitive)', () => {
  beforeAll(async () => {
    // ensure db module loaded
    void rootDb;
  });
  afterAll(async () => {
    await resetDb();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('test 14: restore theta before!=null upserts the WHOLE row back to `before` (verbatim)', async () => {
    const kcId = 'kc_restore_14';
    // Seed a mastery_state row at the pre-attempt state (θ̂=X + full counts/precision).
    const X = 1.25;
    // YUK-561 FIX-3 — a NON-null theta_grid_json `before` closes the one column that was
    // never round-tripped through a non-null verbatim restore (it is A4-dark today, so
    // every prior test left it null). Exact-double grid points (/64) so the jsonb round-
    // trip is lossless; a DIFFERENT grid on the live row proves restore overwrites it.
    const beforeGrid = {
      probs: Array.from({ length: GRID_POINTS }, (_, i) => (i + 1) / 64),
      evidence: 6,
    };
    const afterGrid = {
      probs: Array.from({ length: GRID_POINTS }, () => 0.25),
      evidence: 9,
    };
    const beforeRow = richTheta({
      theta_hat: X,
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      theta_precision: 4.5,
      last_theta_delta: 0.3,
      last_outcome_at: new Date('2026-06-01T00:00:00Z'),
      rt_correct_ms: { samples: [1100, 800] },
      theta_grid_json: beforeGrid,
    });
    await upsertMasteryState(testDb(), {
      subject_id: kcId,
      theta_hat: X,
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      last_outcome_at: new Date('2026-06-01T00:00:00Z'),
      theta_precision: 4.5,
      last_theta_delta: 0.3,
      rt_correct_ms: { samples: [1100, 800] },
      theta_grid_json: beforeGrid,
    });
    // Simulate the attempt having moved θ̂ to Y + advanced the counts/precision/grid.
    const Y = 2.5;
    await upsertMasteryState(testDb(), {
      subject_id: kcId,
      theta_hat: Y,
      evidence_count: 4,
      success_count: 3,
      fail_count: 1,
      last_outcome_at: new Date('2026-06-21T00:00:00Z'),
      theta_precision: 5.9,
      last_theta_delta: 1.25,
      rt_correct_ms: { samples: [1100, 800, 700] },
      theta_grid_json: afterGrid,
    });
    // Oracle: current live row is Y.
    expect(await readTheta(kcId)).toBe(Y);

    // Restore inside a tx (primitive takes a tx per plan §2).
    await testDb().transaction(async (tx: Tx) => {
      const r = await restoreStateSnapshot(
        tx,
        snapshotPayload([{ kc_id: kcId, before: beforeRow, after: Y }], []),
      );
      expect(r.ok).toBe(true);
    });

    // Oracle: the WHOLE row is restored to `before` byte-for-byte — not just θ̂ with
    // zeroed counts (the pre-S1 bug). Every captured column comes back.
    const row = await readMasteryRow(kcId);
    expect(row).not.toBeNull();
    expect(row?.theta_hat).toBe(X);
    expect(row?.evidence_count).toBe(3);
    expect(row?.success_count).toBe(2);
    expect(row?.fail_count).toBe(1);
    expect(row?.theta_precision).toBe(4.5);
    expect(row?.last_theta_delta).toBeCloseTo(0.3, 5);
    expect(row?.last_outcome_at?.getTime()).toBe(new Date('2026-06-01T00:00:00Z').getTime());
    expect((row?.rt_correct_ms as { samples: number[] } | null)?.samples).toEqual([1100, 800]);
    // FIX-3 — theta_grid_json round-trips verbatim (restored to `before`, not left at afterGrid).
    expect(row?.theta_grid_json).toEqual(beforeGrid);
  });
});
