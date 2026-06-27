// YUK-445 (A11 — 谨慎 / 速度-精度轴) — the SINGLE writer + reader of learner_axis_state.
//
// Batch, nightly, per-KC. Reads attempt events (RT + outcome) from the event log, groups them
// by the question's PRIMARY KC, and for each KC with ≥ AXIS_MIN_OBS scored RT-bearing responses
// recovers the EZ-diffusion descriptor (drift_v, boundary_a, ter) from THIS learner's own
// correct-RT moments + Pc (ez-diffusion.ts). It writes ONLY learner_axis_state — never θ̂ /
// FSRS / scheduling — so it touches no LIVE estimation engine (descriptor only; read-out is
// display-only via placement-profile). No dark-ship flag is needed.
//
// ── provenance gate (the A11 hard boundary) ─────────────────────────────────────────────────
// In an ADAPTIVE flow item selection pins Pc to a target band, confounding the DRIFT
// interpretation (v absorbs the selection strategy, not just the learner). So drift_v is
// persisted ONLY for provenance='probe' (a non-adaptive fixed-difficulty probe-set). The live
// main flow is adaptive → we persist boundary_a + ter and leave drift_v NULL. No non-adaptive
// probe-set source exists yet, so this batch always runs with provenance='adaptive'; the
// column + the writer + the gate are wired now, the probe-set data source is the deferred flip.
//
// ── usage gate ──────────────────────────────────────────────────────────────────────────────
// AXIS_MIN_OBS scored responses per KC before we attempt a recovery (data-sparse → no row,
// NOT a flag). Below the gate, or a degenerate EZ recovery (chance Pc / <2 correct RTs), the
// KC is simply skipped — the descriptor stays absent rather than fabricated.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event, learner_axis_state, question } from '@/db/schema';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { type EzResult, ezFromResponses } from './ez-diffusion';

/** Usage gate: minimum scored, RT-bearing responses on a KC before a recovery is attempted. */
export const AXIS_MIN_OBS = 30;

export type AxisProvenance = 'adaptive' | 'probe';

/** One scored, RT-bearing attempt reduced to the two fields A11 needs. */
export interface AxisAttempt {
  /** primary KC the attempt exercises (question.knowledge_ids[0]). */
  kc: string;
  /** true iff outcome === 'success'. */
  correct: boolean;
  /** response time in SECONDS (duration_ms / 1000), finite and > 0. */
  rtSeconds: number;
}

export interface KcAccumulator {
  /** RTs of the CORRECT responses only (EZ uses correct-trial moments). */
  correctRtSeconds: number[];
  correctCount: number;
  totalCount: number;
}

/**
 * Fold raw scored attempts into per-KC accumulators. PURE. correctRtSeconds collects ONLY the
 * correct responses' RTs (EZ moment requirement); totalCount counts every scored response so Pc
 * = correctCount/totalCount over the same set.
 */
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
  /** whether drift_v should be persisted (provenance='probe' AND a finite v). */
  persistDriftV: boolean;
}

/**
 * Apply the usage gate + EZ recovery + provenance gate to one KC accumulator. PURE.
 * Returns null when the usage gate is not met (no row should be written). When the recovery is
 * degenerate the EzResult carries the reason and boundary_a/ter come back null — the caller
 * still upserts (an explicit "we have N obs but no usable signal" row), but never fabricates.
 */
export function recoverKcAxis(
  kc: string,
  acc: KcAccumulator,
  provenance: AxisProvenance,
  minObs: number = AXIS_MIN_OBS,
): KcAxisRecovery | null {
  if (acc.totalCount < minObs) return null;
  const ez = ezFromResponses(acc.correctRtSeconds, acc.correctCount, acc.totalCount);
  // drift_v is only admissible on a non-adaptive probe-set; the adaptive flow confounds it.
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

/**
 * Single-writer upsert of one (subject_kind, subject_id) axis row. Advisory-locked in an
 * INDEPENDENT namespace `axis_state:<kind>:<id>` (distinct hashtext keyspace from mastery_state
 * `fsrs:`/`mastery:` and kc_typed_state `kc_typed:` locks → no collision). Slow-varying
 * overwrite (the row is fully recomputed each batch). Writes NO FSRS / mastery / θ̂ state.
 */
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

export interface AxisStateRow {
  subjectId: string;
  driftV: number | null;
  boundaryA: number | null;
  ter: number | null;
  nObs: number;
  provenance: string;
  updatedAt: Date;
}

/**
 * Read the axis descriptor for a set of KCs (read-out surface). Returns a Map keyed by
 * subject_id; KCs without a row are simply absent. Read-only.
 */
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
  /** provenance of THIS batch's response source. Default 'adaptive' (the only live source). */
  provenance?: AxisProvenance;
  /** usage gate override (tests). Default AXIS_MIN_OBS. */
  minObs?: number;
}

export interface AxisBatchResult {
  /** distinct KCs that met the usage gate and were upserted. */
  written: number;
  /** distinct KCs seen with at least one scored RT-bearing attempt. */
  kcsSeen: number;
  /** KCs upserted whose EZ recovery was non-'ok' (boundary_a/ter null but n_obs recorded). */
  degenerate: number;
}

/**
 * Load scored, RT-bearing attempt events, fold them per primary KC, and upsert one
 * learner_axis_state row per KC that meets the usage gate. PRE-write reads are OUTSIDE any
 * per-KC swallow (a throw is a retryable DB fault → pg-boss retries). Per-KC upserts are
 * independent: one failure is logged + counted, the rest proceed.
 *
 * Attempt admission: action ∈ {attempt, review}, subject_kind='question', outcome ∈
 * {success, failure} (partial / unsupported excluded — EZ is binary), AND a finite positive
 * payload.duration_ms (only RT-bearing solo attempts carry the timing EZ needs; paper attempts
 * write no RT and are naturally excluded). Attributed to the question's PRIMARY KC
 * (knowledge_ids[0], the canonical-primary convention used across the calibration loaders).
 */
export async function runAxisStateBatch(
  db: Db,
  deps: AxisBatchDeps = {},
): Promise<AxisBatchResult> {
  const provenance: AxisProvenance = deps.provenance ?? 'adaptive';
  const minObs = deps.minObs ?? AXIS_MIN_OBS;
  const result: AxisBatchResult = { written: 0, kcsSeen: 0, degenerate: 0 };

  // 1. Scored attempt events, time-ordered (stable tiebreak).
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

  // 2. Per-question primary KC.
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

  // 3. Reduce to scored RT-bearing attempts attributed to a primary KC.
  const attempts: AxisAttempt[] = [];
  for (const r of attemptRows) {
    if (r.subject_id === null) continue;
    const kc = primaryKcByQuestion.get(r.subject_id);
    if (!kc) continue; // question gone / no resolvable KC
    const durationMs = (r.payload as Record<string, unknown> | null)?.duration_ms;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) continue;
    attempts.push({ kc, correct: r.outcome === 'success', rtSeconds: durationMs / 1000 });
  }

  const byKc = foldResponsesByKc(attempts);
  result.kcsSeen = byKc.size;

  // 4. Gate + recover + upsert per KC.
  for (const [kc, acc] of byKc) {
    const recovery = recoverKcAxis(kc, acc, provenance, minObs);
    if (!recovery) continue; // usage gate not met
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
