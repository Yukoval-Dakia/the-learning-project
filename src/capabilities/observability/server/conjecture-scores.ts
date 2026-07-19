// conjecture-wire #13 (YUK-538 ⑬ / spec §6 S4 + §10 A4 fix) — admin reader for the
// conjecture calibration loop. READ-ONLY.
//
// A4 fix (「reader before producer」红线真守): the reconcile loop AUTO-MINTS
// `kc_typed_state` rows (typed_state='confused-with-X') on every confirmed probe.
// Producer wire (S2/S3) → probe_result events accumulate → reconcile mints typed_state
// silently. This reader observes BOTH halves of the consumer output so the owner has a
// window onto auto-minted soft-track state changes, not just the LOG-only score events.
//
// TWO READS (A4):
//   (a) prediction_score events — LOG-only calibration anchors (brier / log_loss /
//       skill_score_point single-point, NOT a window mean; never «accuracy»).
//   (b) kc_typed_state WHERE typed_state='confused-with-X' — the structural soft-track
//       state the reconcile loop auto-mints (provenance via evidence_event_ids).
//
// Honesty: score values render as their canonical names (brier_model / brier_baseline /
// log_loss_model / skill_score_point). skill_score_point is a SINGLE-POINT proper score
// (scoring.ts), NOT the Rust-deferred window mean (ADR-0046) — the response declares this
// in `score_basis: 'single_point'` so no consumer mistakes it for a window-calibrated score.

import type { Db } from '@/db/client';
import { event, kc_typed_state } from '@/db/schema';
import { and, desc, eq } from 'drizzle-orm';

/** One LOG-only calibration score row (mapped from an experimental:prediction_score event). */
export interface ConjecturePredictionScoreRow {
  event_id: string;
  conjecture_event_id: string;
  probe_result_event_id: string;
  knowledge_id: string;
  predicted_p: number;
  baseline_p: number;
  outcome: 0 | 1;
  resolution: 'confirmed' | 'retired';
  brier_model: number | null;
  brier_baseline: number | null;
  log_loss_model: number | null;
  skill_score_point: number | null;
  retrievability_at_judge: number | null;
  created_at: string;
}

/** One auto-minted soft-track typed-state row (the reconcile loop's structural output). */
export interface ConjectureTypedStateRow {
  id: string;
  knowledge_id: string;
  typed_state: 'confused-with-X';
  confused_with_kc_id: string;
  lifecycle: 'open' | 'resolved';
  evidence_event_ids: string[];
  last_evidence_at: string | null;
  updated_at: string;
}

export interface ConjectureScoresRead {
  /** Honest score basis declaration — single_point proper score (scoring.ts), NOT a window mean. */
  score_basis: 'single_point';
  prediction_scores: ConjecturePredictionScoreRow[];
  typed_states: ConjectureTypedStateRow[];
  diagnostics: {
    prediction_scores: ConjectureScanDiagnostics;
    typed_states: ConjectureScanDiagnostics;
  };
}

export interface ConjectureScanDiagnostics {
  /** Raw matching rows actually passed through the fail-closed mapper. */
  scanned_count: number;
  /** Scanned rows rejected by the mapper. Unscanned older rows are not counted. */
  dropped_count: number;
  /** True when older matching rows exist but the result/scan bound stopped inspection. */
  scan_truncated: boolean;
}

const PREDICTION_SCORE_ACTION = 'experimental:prediction_score';
const ADMIN_RESULT_LIMIT = 200;
// Invalid rows fail closed after selection. Bounded over-fetch keeps a small corrupt tail from
// crowding valid diagnostics out of the response without returning to an unbounded table scan.
const ADMIN_SCAN_LIMIT = ADMIN_RESULT_LIMIT * 2;

type OptionalNumber = { ok: true; value: number | null } | { ok: false };

function optionalFiniteNumber(value: unknown): OptionalNumber {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function rowToScore(r: typeof event.$inferSelect): ConjecturePredictionScoreRow | null {
  const p = r.payload as Record<string, unknown> | null;
  if (!p) return null;
  // Fail-closed per field: a prediction_score with a missing/invalid load-bearing value
  // is dropped (never partially rendered) — mirrors hard-confirm.ts predictionScoreToRecord.
  const predicted_p = p.predicted_p;
  const baseline_p = p.baseline_p;
  const outcome = p.outcome;
  const resolution = p.resolution;
  if (typeof predicted_p !== 'number' || !Number.isFinite(predicted_p)) return null;
  if (typeof baseline_p !== 'number' || !Number.isFinite(baseline_p)) return null;
  if (outcome !== 0 && outcome !== 1) return null;
  if (resolution !== 'confirmed' && resolution !== 'retired') return null;
  const conj = p.conjecture_event_id;
  const probe = p.probe_result_event_id;
  const kc = p.knowledge_id;
  if (!isNonEmptyString(conj) || !isNonEmptyString(probe) || !isNonEmptyString(kc)) return null;
  if (!isValidDate(r.created_at)) return null;
  const brierModel = optionalFiniteNumber(p.brier_model);
  const brierBaseline = optionalFiniteNumber(p.brier_baseline);
  const logLossModel = optionalFiniteNumber(p.log_loss_model);
  const skillScorePoint = optionalFiniteNumber(p.skill_score_point);
  const retrievability = optionalFiniteNumber(p.retrievability_at_judge);
  if (
    !brierModel.ok ||
    !brierBaseline.ok ||
    !logLossModel.ok ||
    !skillScorePoint.ok ||
    !retrievability.ok
  ) {
    return null;
  }
  return {
    event_id: r.id,
    conjecture_event_id: conj,
    probe_result_event_id: probe,
    knowledge_id: kc,
    predicted_p,
    baseline_p,
    outcome,
    resolution,
    brier_model: brierModel.value,
    brier_baseline: brierBaseline.value,
    log_loss_model: logLossModel.value,
    skill_score_point: skillScorePoint.value,
    retrievability_at_judge: retrievability.value,
    created_at: r.created_at.toISOString(),
  };
}

function rowToTypedState(r: typeof kc_typed_state.$inferSelect): ConjectureTypedStateRow | null {
  if (!isNonEmptyString(r.id) || r.subject_kind !== 'knowledge') return null;
  if (!isNonEmptyString(r.subject_id) || r.typed_state !== 'confused-with-X') return null;
  if (!isNonEmptyString(r.confused_with_kc_id)) return null;
  if (r.lifecycle !== 'open' && r.lifecycle !== 'resolved') return null;
  if (!Array.isArray(r.evidence_event_ids) || !r.evidence_event_ids.every(isNonEmptyString)) {
    return null;
  }
  if (r.last_evidence_at !== null && !isValidDate(r.last_evidence_at)) return null;
  if (!isValidDate(r.updated_at)) return null;
  return {
    id: r.id,
    knowledge_id: r.subject_id,
    typed_state: r.typed_state,
    confused_with_kc_id: r.confused_with_kc_id,
    lifecycle: r.lifecycle,
    evidence_event_ids: r.evidence_event_ids,
    last_evidence_at: r.last_evidence_at?.toISOString() ?? null,
    updated_at: r.updated_at.toISOString(),
  };
}

function collectBoundedRows<Raw, Mapped>(
  rowsWithSentinel: readonly Raw[],
  map: (row: Raw) => Mapped | null,
): { rows: Mapped[]; diagnostics: ConjectureScanDiagnostics } {
  // The query fetches one sentinel beyond the hard scan window solely to distinguish exactly-N rows
  // from a genuinely truncated backlog. The sentinel is never mapped and is not counted as scanned.
  const scanWindow = rowsWithSentinel.slice(0, ADMIN_SCAN_LIMIT);
  const rows: Mapped[] = [];
  let scanned_count = 0;
  let dropped_count = 0;
  for (const raw of scanWindow) {
    scanned_count += 1;
    const mapped = map(raw);
    if (mapped === null) dropped_count += 1;
    else rows.push(mapped);
    if (rows.length === ADMIN_RESULT_LIMIT) break;
  }
  return {
    rows,
    diagnostics: {
      scanned_count,
      dropped_count,
      scan_truncated:
        rowsWithSentinel.length > ADMIN_SCAN_LIMIT || scanned_count < scanWindow.length,
    },
  };
}

/**
 * READ-ONLY admin reader. Two queries (A4): prediction_score events (LOG anchors) +
 * kc_typed_state confused-with-X rows (auto-minted structural soft-track state).
 * Never writes. Never flips flags. Never touches FSRS/θ̂ (ND-5).
 */
export async function loadConjectureScores(db: Db): Promise<ConjectureScoresRead> {
  const scoreRows = await db
    .select()
    .from(event)
    .where(eq(event.action, PREDICTION_SCORE_ACTION))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(ADMIN_SCAN_LIMIT + 1);
  const scores = collectBoundedRows(scoreRows, rowToScore);
  const typedRows = await db
    .select()
    .from(kc_typed_state)
    .where(
      and(
        eq(kc_typed_state.subject_kind, 'knowledge'),
        eq(kc_typed_state.typed_state, 'confused-with-X'),
      ),
    )
    .orderBy(desc(kc_typed_state.updated_at), desc(kc_typed_state.id))
    .limit(ADMIN_SCAN_LIMIT + 1);
  const typed = collectBoundedRows(typedRows, rowToTypedState);

  return {
    score_basis: 'single_point',
    prediction_scores: scores.rows,
    typed_states: typed.rows,
    diagnostics: {
      prediction_scores: scores.diagnostics,
      typed_states: typed.diagnostics,
    },
  };
}
