// Batch writer of the EZ descriptor on learner_axis_state. It does not write θ̂, FSRS, or scheduling.
// drift_v is stored only for provenance 'probe'. Adaptive selection pins Pc, so v there
// absorbs the policy. The live default is 'adaptive'. Probe is wired, and nothing feeds it yet.
// Below AXIS_MIN_OBS the KC gets no row. A degenerate recovery still upserts, with null
// boundary and ter, so the absence of a signal is recorded instead of invented.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event, learner_axis_state, question } from '@/db/schema';
import { acquireSortedAdvisoryLocks } from '@/server/advisory-locks';
import { type EzResult, ezFromResponses } from './ez-diffusion';

/** Below this, no row. A sparser KC stays absent rather than getting a made-up descriptor. */
export const AXIS_MIN_OBS = 30;

export type AxisProvenance = 'adaptive' | 'probe';

export interface AxisAttempt {
  /** question.knowledge_ids[0]. Later knowledge ids on the question are not this attempt's KC. */
  kc: string;
  correct: boolean;
  /** Seconds, from duration_ms / 1000. Finite and > 0. */
  rtSeconds: number;
}

export interface KcAccumulator {
  /** Correct trials only. EZ moments ignore error RTs. totalCount still includes them, for Pc. */
  correctRtSeconds: number[];
  correctCount: number;
  totalCount: number;
}

export function foldResponsesByKc(attempts: AxisAttempt[]): Map<string, KcAccumulator> {
  const byKc = new Map<string, KcAccumulator>();
  for (const a of attempts) {
    let acc = byKc.get(a.kc);
    if (!acc) {
      acc = { correctRtSeconds: [], correctCount: 0, totalCount: 0 };
      byKc.set(a.kc, acc);
    }
    acc.totalCount += 1;
    if (a.correct) {
      acc.correctCount += 1;
      acc.correctRtSeconds.push(a.rtSeconds);
    }
  }
  return byKc;
}

export interface KcAxisRecovery {
  kc: string;
  ez: EzResult;
  nObs: number;
  /** True only for a probe provenance with a finite v. Adaptive drift is not stored. */
  persistDriftV: boolean;
}

/** Null means below the usage gate, so the caller writes nothing. A degenerate result is not null. */
export function recoverKcAxis(
  kc: string,
  acc: KcAccumulator,
  provenance: AxisProvenance,
  minObs: number = AXIS_MIN_OBS,
): KcAxisRecovery | null {
  if (acc.totalCount < minObs) return null;
  const ez = ezFromResponses(acc.correctRtSeconds, acc.correctCount, acc.totalCount);
  // Adaptive v absorbs the selection policy, so it is not a learner drift.
  const persistDriftV = provenance === 'probe' && ez.v !== null && Number.isFinite(ez.v);
  return { kc, ez, nObs: acc.totalCount, persistDriftV };
}

export interface AxisStateUpsert {
  subjectId: string;
  subjectKind?: string;
  driftV: number | null;
  boundaryA: number | null;
  ter: number | null;
  nObs: number;
  provenance: AxisProvenance;
}

/** Lock namespace `axis_state:` is distinct from `fsrs:`, `mastery:`, and `kc_typed:`. The row is replaced, not merged. */
export async function upsertLearnerAxisState(db: Db, input: AxisStateUpsert): Promise<void> {
  const subjectKind = input.subjectKind ?? 'knowledge';
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`axis_state:${subjectKind}:${input.subjectId}`}))`,
    );
    await tx
      .insert(learner_axis_state)
      .values({
        id: newId(),
        subject_kind: subjectKind,
        subject_id: input.subjectId,
        drift_v: input.driftV,
        boundary_a: input.boundaryA,
        ter: input.ter,
        n_obs: input.nObs,
        provenance: input.provenance,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [learner_axis_state.subject_kind, learner_axis_state.subject_id],
        set: {
          drift_v: input.driftV,
          boundary_a: input.boundaryA,
          ter: input.ter,
          n_obs: input.nObs,
          provenance: input.provenance,
          updated_at: now,
        },
      });
  });
}

/** Does not average the two recoveries. Averaging would invent a descriptor. Both ids take `axis_state:` locks, sorted, on this transaction. The nightly batch opens its own, so the locks are what serialize them. */
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

export interface AxisBatchDeps {
  /** Default 'adaptive'. 'probe' is accepted, and no live source passes it yet. */
  provenance?: AxisProvenance;
  minObs?: number;
}

export interface AxisBatchResult {
  written: number;
  kcsSeen: number;
  /** Upserts whose recovery was not 'ok'. The row exists. boundary and ter are null. */
  degenerate: number;
}

/** A throw while loading is outside the per-KC catch, so the queue retries it. One upsert failure is logged and the other KCs still write. Partial outcomes and attempts with no positive duration_ms stay out. EZ is binary, and paper attempts carry no RT. */
export async function runAxisStateBatch(
  db: Db,
  deps: AxisBatchDeps = {},
): Promise<AxisBatchResult> {
  const provenance: AxisProvenance = deps.provenance ?? 'adaptive';
  const minObs = deps.minObs ?? AXIS_MIN_OBS;
  const result: AxisBatchResult = { written: 0, kcsSeen: 0, degenerate: 0 };

  const attemptRows = await db
    .select({
      outcome: event.outcome,
      payload: event.payload,
      subject_id: event.subject_id,
    })
    .from(event)
    .where(
      and(
        inArray(event.action, ['attempt', 'review']),
        eq(event.subject_kind, 'question'),
        inArray(event.outcome, ['success', 'failure']),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id));
  if (attemptRows.length === 0) return result;

  const questionIds = Array.from(
    new Set(attemptRows.map((r) => r.subject_id).filter((id): id is string => id !== null)),
  );
  const qRows =
    questionIds.length > 0
      ? await db
          .select({ id: question.id, knowledge_ids: question.knowledge_ids })
          .from(question)
          .where(inArray(question.id, questionIds))
      : [];
  const primaryKcByQuestion = new Map<string, string>();
  for (const q of qRows) {
    const primary = (q.knowledge_ids ?? []).map((k) => k.trim()).find((k) => k.length > 0);
    if (primary) primaryKcByQuestion.set(q.id, primary);
  }

  const attempts: AxisAttempt[] = [];
  for (const r of attemptRows) {
    if (r.subject_id === null) continue;
    const kc = primaryKcByQuestion.get(r.subject_id);
    if (!kc) continue;
    const durationMs = (r.payload as Record<string, unknown> | null)?.duration_ms;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) continue;
    attempts.push({ kc, correct: r.outcome === 'success', rtSeconds: durationMs / 1000 });
  }

  const byKc = foldResponsesByKc(attempts);
  result.kcsSeen = byKc.size;

  for (const [kc, acc] of byKc) {
    const recovery = recoverKcAxis(kc, acc, provenance, minObs);
    if (!recovery) continue;
    if (recovery.ez.reason !== 'ok') result.degenerate += 1;
    try {
      await upsertLearnerAxisState(db, {
        subjectId: kc,
        driftV: recovery.persistDriftV ? recovery.ez.v : null,
        boundaryA: recovery.ez.a,
        ter: recovery.ez.ter,
        nObs: recovery.nObs,
        provenance,
      });
      result.written += 1;
    } catch (err) {
      console.error('[axis_state_batch] upsert failed', { kc, err });
    }
  }

  return result;
}
