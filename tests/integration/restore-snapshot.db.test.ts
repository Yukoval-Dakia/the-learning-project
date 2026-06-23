// YUK-471 Wave 0 — restore-snapshot primitive db tests (plan §4 group D, tests 14-18).
//
// The oracle for `after` is ALWAYS the live `mastery_state` / `material_fsrs_state`
// row read directly from the DB — NOT the snapshot payload (tautology trap, plan §6.8).
// The oracle for `before` is the seeded value we wrote before invoking restore.
//
// These tests MUST be db-config (they import tests/helpers/db + drizzle + resetDb).

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { StateSnapshotExperimentalT } from '@/core/schema/event/state-snapshot';
import { db as rootDb } from '@/db/client';
import type { Tx } from '@/db/client';
import { mastery_state, material_fsrs_state } from '@/db/schema';
import { upsertFsrsState } from '@/server/fsrs/state';
import { upsertMasteryState } from '@/server/mastery/state';
import { restoreStateSnapshot } from '@/server/revert/restore-snapshot';

import { resetDb, testDb } from '../helpers/db';

// A valid ts-fsrs-v5 Card shape (reused for seed + restore payloads). Numbers are
// arbitrary but valid per FsrsStateSchema; restore must overwrite with `before`.
function card(reps: number, stability: number): FsrsStateSchemaT {
  return {
    due: new Date('2026-07-01T00:00:00Z'),
    stability,
    difficulty: 5.5,
    elapsed_days: 0,
    scheduled_days: 1,
    learning_steps: 2,
    reps,
    lapses: 0,
    state: 'review',
    last_review: new Date('2026-06-20T00:00:00Z'),
  };
}

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

// Read a material_fsrs_state reps directly from DB (independent oracle).
async function readFsrsReps(
  subjectKind: 'question' | 'knowledge',
  subjectId: string,
): Promise<number | null> {
  const rows = await testDb()
    .select({ state: material_fsrs_state.state })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subjectKind),
        eq(material_fsrs_state.subject_id, subjectId),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  const state = rows[0].state as FsrsStateSchemaT;
  return state.reps;
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

  it('test 14: restore theta before!=null upserts the row back to `before`', async () => {
    const kcId = 'kc_restore_14';
    // Seed a mastery_state row at θ̂=X (the pre-attempt state).
    const X = 1.25;
    await upsertMasteryState(testDb(), {
      subject_id: kcId,
      theta_hat: X,
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      last_outcome_at: new Date('2026-06-01T00:00:00Z'),
    });
    // Simulate the attempt having moved θ̂ to Y (current DB state != before).
    const Y = 2.5;
    await upsertMasteryState(testDb(), {
      subject_id: kcId,
      theta_hat: Y,
      evidence_count: 4,
      success_count: 3,
      fail_count: 1,
      last_outcome_at: new Date('2026-06-21T00:00:00Z'),
    });
    // Oracle: current live row is Y.
    expect(await readTheta(kcId)).toBe(Y);

    // Restore inside a tx (primitive takes a tx per plan §2).
    await testDb().transaction(async (tx: Tx) => {
      await restoreStateSnapshot(tx, snapshotPayload([{ kc_id: kcId, before: X, after: Y }], []));
    });

    // Oracle: live row theta_hat must now equal X (before), not Y.
    expect(await readTheta(kcId)).toBe(X);
  });

  it('test 15: restore theta before=null deletes the cold-start row', async () => {
    const kcId = 'kc_restore_15';
    // The attempt created this row (cold-start before=null). Seed current=Y.
    const Y = 0.75;
    await upsertMasteryState(testDb(), {
      subject_id: kcId,
      theta_hat: Y,
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: new Date('2026-06-21T00:00:00Z'),
    });
    expect(await readTheta(kcId)).toBe(Y);

    await testDb().transaction(async (tx: Tx) => {
      await restoreStateSnapshot(
        tx,
        snapshotPayload(
          // before=null → cold-start → revert must DELETE the row.
          [{ kc_id: kcId, before: null, after: Y }],
          [],
        ),
      );
    });

    // Oracle: the row is GONE.
    expect(await readTheta(kcId)).toBeNull();
  });

  it('test 16: restore fsrs before!=null upserts the row back to `before`', async () => {
    const subjectId = 'fsrs_restore_16';
    // Seed prior FSRS Card (before).
    const beforeCard = card(7, 10.0);
    await upsertFsrsState(testDb(), {
      subject_kind: 'question',
      subject_id: subjectId,
      state: beforeCard,
      due_at: new Date('2026-07-01T00:00:00Z'),
      last_review_event_id: 'evt_before_16',
    });
    // Simulate the attempt overwriting with a new Card (after).
    const afterCard = card(8, 12.0);
    await upsertFsrsState(testDb(), {
      subject_kind: 'question',
      subject_id: subjectId,
      state: afterCard,
      due_at: new Date('2026-07-02T00:00:00Z'),
      last_review_event_id: 'evt_after_16',
    });
    // Oracle: current live reps == 8.
    expect(await readFsrsReps('question', subjectId)).toBe(8);

    await testDb().transaction(async (tx: Tx) => {
      await restoreStateSnapshot(
        tx,
        snapshotPayload(
          [],
          [
            {
              subject_kind: 'question',
              subject_id: subjectId,
              before: beforeCard,
              after: afterCard,
            },
          ],
        ),
      );
    });

    // Oracle: live reps == 7 (the `before` Card).
    expect(await readFsrsReps('question', subjectId)).toBe(7);
  });

  it('test 17: restore fsrs before=null deletes the cold-start row', async () => {
    const subjectId = 'fsrs_restore_17';
    const afterCard = card(1, 1.0);
    // The attempt created this row (cold-start before=null). Seed current=after.
    await upsertFsrsState(testDb(), {
      subject_kind: 'question',
      subject_id: subjectId,
      state: afterCard,
      due_at: new Date('2026-07-03T00:00:00Z'),
      last_review_event_id: 'evt_after_17',
    });
    expect(await readFsrsReps('question', subjectId)).toBe(1);

    await testDb().transaction(async (tx: Tx) => {
      await restoreStateSnapshot(
        tx,
        snapshotPayload(
          [],
          [
            {
              subject_kind: 'question',
              subject_id: subjectId,
              before: null,
              after: afterCard,
            },
          ],
        ),
      );
    });

    // Oracle: the row is GONE.
    expect(await readFsrsReps('question', subjectId)).toBeNull();
  });

  it('test 18: restore is segment-independent (theta before=null + fsrs before!=null)', async () => {
    const kcId = 'kc_restore_18';
    const subjectId = 'fsrs_restore_18';

    // theta: cold-start row currently exists (must be deleted on revert).
    await upsertMasteryState(testDb(), {
      subject_id: kcId,
      theta_hat: 0.9,
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: new Date('2026-06-21T00:00:00Z'),
    });
    // fsrs: prior Card exists (must be restored to `before`).
    const fsrsBefore = card(3, 4.0);
    const fsrsAfter = card(4, 5.0);
    await upsertFsrsState(testDb(), {
      subject_kind: 'question',
      subject_id: subjectId,
      state: fsrsBefore,
      due_at: new Date('2026-07-01T00:00:00Z'),
      last_review_event_id: 'evt_before_18',
    });
    await upsertFsrsState(testDb(), {
      subject_kind: 'question',
      subject_id: subjectId,
      state: fsrsAfter,
      due_at: new Date('2026-07-02T00:00:00Z'),
      last_review_event_id: 'evt_after_18',
    });

    expect(await readTheta(kcId)).toBe(0.9);
    expect(await readFsrsReps('question', subjectId)).toBe(4);

    await testDb().transaction(async (tx: Tx) => {
      await restoreStateSnapshot(
        tx,
        snapshotPayload(
          // theta segment: before=null → DELETE (cold-start revert)
          [{ kc_id: kcId, before: null, after: 0.9 }],
          // fsrs segment: before!=null → UPSERT back (warm revert)
          [
            {
              subject_kind: 'question',
              subject_id: subjectId,
              before: fsrsBefore,
              after: fsrsAfter,
            },
          ],
        ),
      );
    });

    // Oracle: theta row deleted AND fsrs row restored — the two segments reverted
    // independently (ADR-0035 R⟂p(L)).
    expect(await readTheta(kcId)).toBeNull();
    expect(await readFsrsReps('question', subjectId)).toBe(3);
  });

  it('no-op on empty arrays (degenerate snapshot with no KCs / no FSRS subjects)', async () => {
    // Plant one row of each kind — restore with empty arrays must NOT touch them.
    await upsertMasteryState(testDb(), {
      subject_id: 'kc_noop',
      theta_hat: 1.0,
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: new Date('2026-06-21T00:00:00Z'),
    });
    await upsertFsrsState(testDb(), {
      subject_kind: 'question',
      subject_id: 'fsrs_noop',
      state: card(1, 1.0),
      due_at: new Date('2026-07-01T00:00:00Z'),
      last_review_event_id: 'evt_noop',
    });

    await testDb().transaction(async (tx: Tx) => {
      await restoreStateSnapshot(tx, snapshotPayload([], []));
    });

    expect(await readTheta('kc_noop')).toBe(1.0);
    expect(await readFsrsReps('question', 'fsrs_noop')).toBe(1);
  });
});
