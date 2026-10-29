// Read/retire side of learner_axis_state (A11). The nightly batch writer was
// retired in YUK-1560; rows stay for the display-only placement-profile read and
// are only renamed/frozen when knowledge nodes merge. No live estimation consumer.

import { and, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { acquireSortedAdvisoryLocks } from '@/db/learning-state-lock';
import { learner_axis_state } from '@/db/schema';

/** Does not average the two recoveries. Averaging would invent a descriptor. Both ids take `axis_state:` locks, sorted, on this transaction. */
export async function retireLearnerAxisStateOnMerge(
  tx: Tx,
  fromId: string,
  intoId: string,
  subjectKind = 'knowledge',
): Promise<'noop' | 'renamed' | 'frozen'> {
  await acquireSortedAdvisoryLocks(tx, `axis_state:${subjectKind}`, [fromId, intoId]);
  const rows = await tx
    .select({ subject_id: learner_axis_state.subject_id })
    .from(learner_axis_state)
    .where(
      and(
        eq(learner_axis_state.subject_kind, subjectKind),
        inArray(learner_axis_state.subject_id, [fromId, intoId]),
      ),
    );
  const present = new Set(rows.map((r) => r.subject_id));
  if (!present.has(fromId)) return 'noop';
  if (!present.has(intoId)) {
    await tx
      .update(learner_axis_state)
      .set({ subject_id: intoId, updated_at: new Date() })
      .where(
        and(
          eq(learner_axis_state.subject_kind, subjectKind),
          eq(learner_axis_state.subject_id, fromId),
        ),
      );
    return 'renamed';
  }
  console.warn(
    '[retireLearnerAxisStateOnMerge] both from+into have learner_axis_state — freezing from-row (no descriptor merge)',
    { fromId, intoId },
  );
  return 'frozen';
}

export interface AxisStateRow {
  subjectId: string;
  driftV: number | null;
  boundaryA: number | null;
  ter: number | null;
  nObs: number;
  provenance: string;
  updatedAt: Date;
}

/** A KC with no row is absent. It is not filled with a default descriptor. */
export async function readLearnerAxisStates(
  db: Db,
  subjectIds: string[],
  subjectKind = 'knowledge',
): Promise<Map<string, AxisStateRow>> {
  const ids = Array.from(new Set(subjectIds.map((s) => s.trim()).filter((s) => s.length > 0)));
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      subject_id: learner_axis_state.subject_id,
      drift_v: learner_axis_state.drift_v,
      boundary_a: learner_axis_state.boundary_a,
      ter: learner_axis_state.ter,
      n_obs: learner_axis_state.n_obs,
      provenance: learner_axis_state.provenance,
      updated_at: learner_axis_state.updated_at,
    })
    .from(learner_axis_state)
    .where(
      and(
        eq(learner_axis_state.subject_kind, subjectKind),
        inArray(learner_axis_state.subject_id, ids),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.subject_id,
      {
        subjectId: r.subject_id,
        driftV: r.drift_v,
        boundaryA: r.boundary_a,
        ter: r.ter,
        nObs: r.n_obs,
        provenance: r.provenance,
        updatedAt: r.updated_at,
      },
    ]),
  );
}
