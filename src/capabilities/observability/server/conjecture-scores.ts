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
import { desc, eq } from 'drizzle-orm';

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
  brier_model: number;
  brier_baseline: number;
  log_loss_model: number;
  skill_score_point: number;
  retrievability_at_judge: number | null;
  created_at: string;
}

/** One auto-minted soft-track typed-state row (the reconcile loop's structural output). */
export interface ConjectureTypedStateRow {
  id: string;
  knowledge_id: string;
  typed_state: 'confused-with-X';
  confused_with_kc_id: string | null;
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
}

const PREDICTION_SCORE_ACTION = 'experimental:prediction_score';
export const CONJECTURE_SCORES_LIMIT = 200;

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
  if (typeof conj !== 'string' || typeof probe !== 'string' || typeof kc !== 'string') return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const retrievability = p.retrievability_at_judge;
  return {
    event_id: r.id,
    conjecture_event_id: conj,
    probe_result_event_id: probe,
    knowledge_id: kc,
    predicted_p,
    baseline_p,
    outcome,
    resolution,
    brier_model: num(p.brier_model),
    brier_baseline: num(p.brier_baseline),
    log_loss_model: num(p.log_loss_model),
    skill_score_point: num(p.skill_score_point),
    retrievability_at_judge:
      typeof retrievability === 'number' && Number.isFinite(retrievability) ? retrievability : null,
    created_at: r.created_at.toISOString(),
  };
}

function rowToTypedState(r: typeof kc_typed_state.$inferSelect): ConjectureTypedStateRow | null {
  if (r.subject_kind !== 'knowledge' || r.subject_id.length === 0 || r.id.length === 0) return null;
  if (r.typed_state !== 'confused-with-X') return null;
  if (r.lifecycle !== 'open' && r.lifecycle !== 'resolved') return null;
  if (
    !Array.isArray(r.evidence_event_ids) ||
    r.evidence_event_ids.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    return null;
  }
  if (
    r.confused_with_kc_id !== null &&
    (typeof r.confused_with_kc_id !== 'string' || r.confused_with_kc_id.length === 0)
  ) {
    return null;
  }
  return {
    id: r.id,
    knowledge_id: r.subject_id,
    typed_state: 'confused-with-X',
    confused_with_kc_id: r.confused_with_kc_id,
    lifecycle: r.lifecycle,
    evidence_event_ids: r.evidence_event_ids,
    last_evidence_at: r.last_evidence_at ? r.last_evidence_at.toISOString() : null,
    updated_at: r.updated_at.toISOString(),
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
    .limit(CONJECTURE_SCORES_LIMIT);

  const prediction_scores: ConjecturePredictionScoreRow[] = [];
  for (const r of scoreRows) {
    const mapped = rowToScore(r);
    if (mapped) prediction_scores.push(mapped);
  }
  const typedRows = await db
    .select()
    .from(kc_typed_state)
    .where(eq(kc_typed_state.typed_state, 'confused-with-X'))
    .orderBy(desc(kc_typed_state.updated_at), desc(kc_typed_state.id))
    .limit(CONJECTURE_SCORES_LIMIT);

  const typed_states: ConjectureTypedStateRow[] = [];
  for (const r of typedRows) {
    const mapped = rowToTypedState(r);
    if (mapped) typed_states.push(mapped);
  }

  return { score_basis: 'single_point', prediction_scores, typed_states };
}
