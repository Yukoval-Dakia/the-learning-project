// YUK-361 Phase 5 (ADR-0043 family-level b_personalized) — slow family difficulty offset.
//
// Single-question b_j is not identifiable at n=1: the likelihood is invariant under the
// logit shift θ→θ+c, b→b+c. Questions sharing `(subject, primaryKnowledge, kind, source)`
// share a systematic offset, which becomes estimable once enough objective observations
// accumulate. That family offset is the slow second axis: θ̂ moves on every answer, the
// family delta only moves when the family has enough evidence.
//
// Red line: this module never writes item_calibration.b. The family delta is an additive
// read-side adjustment, b_effective = b_anchor + shrunk_b_delta, so the anchor is never
// contaminated. It is applied by the live θ̂ anchor (state.ts) and selection
// (candidate-signals); it never feeds back into the anchor.

import { and, eq, sql } from 'drizzle-orm';
import { impliedDifficultyResidual } from '@/core/calibration/aipw';
import { newId } from '@/core/ids';
import { DIFFICULTY_PROXY_WEIGHT, difficultyToLogitB } from '@/core/theta';
import type { Tx } from '@/db/client';
import { item_calibration, item_family_calibration, mastery_state } from '@/db/schema';
import {
  type FamilyFoldRecord,
  liveFamilyObservationQuestionIds,
} from '@/kernel/read-models/assessment-settlements';
import {
  getFamilyCalibration,
  resolveFamilyKeyForQuestion,
} from '@/kernel/read-models/question-difficulty';

export {
  type FamilyCalibrationRow,
  effectiveFamilyB,
} from '@/kernel/read-models/question-difficulty';

// Gates (ADR-0043 "shrinkage 守保守"): enough observations, enough distinct questions
// (so one repeatedly-drilled question cannot masquerade as family evidence), and an
// empirical-Bayes prior strength. Thresholds are owner-tunable placeholders; until the
// gates first pass, only evidence_count moves and b_delta stays 0.
export const FAMILY_MIN_EVIDENCE = 20;
export const FAMILY_MIN_DISTINCT_QUESTIONS = 5;
export const SHRINKAGE_PRIOR_STRENGTH = 20;

// Objective judge routes only. exact/keyword are deterministic string/set matches with no
// LLM. unit_dimension is excluded despite its accelerator because it has an LLM fallback;
// LLM-backed verdicts would leak judge bias into b.
//
// Even an objective single outcome mixes θ/learning drift. Aggregating over the family
// with shrinkage and the n≥20 gate estimates that systematic offset; it does not write a
// per-attempt b.
export const OBJECTIVE_JUDGE_ROUTES: ReadonlySet<string> = new Set<string>(['exact', 'keyword']);

/** Whether the judge route is deterministic and LLM-free — the family calibration gate. */
export function isObjectiveJudgeRoute(route: string | null | undefined): boolean {
  return route != null && OBJECTIVE_JUDGE_ROUTES.has(route);
}

// Empirical-Bayes shrinkage: shrunk = n/(n+priorStrength)·rawDelta. n=0 → 0 (fully
// shrunk), n=priorStrength → half, n→∞ → raw. Keeps noisy families near zero until they
// have enough evidence.
export function shrinkFamilyDelta(
  rawDelta: number,
  n: number,
  priorStrength = SHRINKAGE_PRIOR_STRENGTH,
): number {
  if (n <= 0) return 0;
  return (n / (n + priorStrength)) * rawDelta;
}

/** The shrinkage factor itself (= confidence), persisted by the update path. */
export function shrinkageFactor(n: number, priorStrength = SHRINKAGE_PRIOR_STRENGTH): number {
  if (n <= 0) return 0;
  return n / (n + priorStrength);
}

// Raw delta: the mean implied difficulty residual over the family's objective observations.
// Per-observation residual: impliedDifficultyResidual in core/calibration/aipw.
//
// b_delta stores the SHRUNK running mean, so updates reconstruct the old raw mean with
//   oldRawMean = storedDelta / shrinkageFactor(calibrated_n).
// calibrated_n must count only residuals actually folded in. Using evidence_count (or
// n−threshold+1) injects phantom mean-0 samples when the distinct gate opens after the
// count gate, permanently diluting b_delta. Folding starts only when both gates pass, so
//   storedDelta = shrinkFamilyDelta(mean(folded residuals), calibrated_n)
// holds regardless of gate-crossing order.
// Update path: accumulate one objective attempt and recompute the shrunk delta.
// Gates: (a) objective outcome, (b) n ≥ FAMILY_MIN_EVIDENCE, (c) at least
// FAMILY_MIN_DISTINCT_QUESTIONS distinct questions. An observation that misses a gate only
// moves evidence_count: b_delta stays 0 before the first fold and keeps its folded mean after.
//
// The distinct count is supplied by the caller because this table deliberately stores no
// question ids (keeping families question-agnostic and bounded). Callers run this inside
// the attempt tx for a consistent count and swallow failures: calibration is a slow gain
// layer and must never abort the θ̂/FSRS/event write.

export interface UpdateFamilyCalibrationInput {
  familyKey: string;
  /** Pre-attempt θ̂ (the fast-scale anchor). */
  theta: number;
  /** item_calibration.b, or the weak difficultyToLogitB fallback. */
  bAnchor: number;
  /** success=1 / failure=0. */
  outcome: 0 | 1;
  /** Gate (a): the judge route is objective. */
  isObjective: boolean;
  /** Gate (c): distinct questions in this family, including the current one. */
  distinctQuestionCount: number;
  /** Weak proxy anchors are down-weighted, matching the θ̂ update. Default 1. */
  anchorWeight?: number;
  now: Date;
}

export async function updateFamilyCalibration(
  tx: Tx,
  input: UpdateFamilyCalibrationInput,
): Promise<FamilyFoldRecord | null> {
  // Gate (a): subjective verdicts never enter the b truth channel.
  if (!input.isObjective) return null;

  // Serialize this family's read-modify-write; released at commit.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`family_calibration:${input.familyKey}`}))`,
  );

  const existing = await getFamilyCalibration(tx, input.familyKey);
  const oldN = existing?.evidence_count ?? 0;
  const newN = oldN + 1;
  // Old fold count: only residuals actually in the mean. 0 until both gates pass.
  const oldCalibratedN = existing?.calibrated_n ?? 0;

  // Use calibrated_n as the running-mean sample base so reconstruction is independent of
  // which gate opened first. Using evidence_count here would treat pre-gate observations
  // as folded and inject phantom mean-0 samples (finding #2), permanently shrinking the
  // delta.
  const distinctOk = input.distinctQuestionCount >= FAMILY_MIN_DISTINCT_QUESTIONS;
  const gatesPassedNow = newN >= FAMILY_MIN_EVIDENCE && distinctOk;
  // Do not infer "folded before" from the current counts: distinctQuestionCount may cross
  // the gate only now. The truth is whether the previous write actually folded a residual.
  const foldedBefore = oldCalibratedN > 0;

  const oldRawMean =
    foldedBefore && existing != null ? existing.b_delta / shrinkageFactor(oldCalibratedN) : 0;

  const anchorWeight = input.anchorWeight ?? 1;
  const residual =
    anchorWeight * impliedDifficultyResidual(input.theta, input.bAnchor, input.outcome);
  const foldedThisObs = gatesPassedNow;

  // The distinct count drops when a revert removes a question's last observation. A gate
  // that closes after folding only keeps this residual out: zeroing b_delta while
  // calibrated_n stays would corrupt the next mean reconstruction and the unfold inverse.
  let storedDelta = foldedBefore ? (existing?.b_delta ?? 0) : 0;
  let storedConfidence = foldedBefore ? (existing?.confidence ?? 0) : 0;
  let newCalibratedN = oldCalibratedN;
  if (gatesPassedNow) {
    newCalibratedN = foldedBefore ? oldCalibratedN + 1 : 1;
    const newRawMean = foldedBefore
      ? oldRawMean + (residual - oldRawMean) / newCalibratedN
      : residual;
    storedConfidence = shrinkageFactor(newCalibratedN);
    storedDelta = shrinkFamilyDelta(newRawMean, newCalibratedN);
  }

  await tx
    .insert(item_family_calibration)
    .values({
      id: newId(),
      family_key: input.familyKey,
      b_delta: storedDelta,
      evidence_count: newN,
      confidence: storedConfidence,
      calibrated_n: newCalibratedN,
      updated_at: input.now,
    })
    .onConflictDoUpdate({
      target: item_family_calibration.family_key,
      set: {
        b_delta: storedDelta,
        evidence_count: newN,
        confidence: storedConfidence,
        calibrated_n: newCalibratedN,
        updated_at: input.now,
      },
    });

  return { familyKey: input.familyKey, folded: foldedThisObs, residual };
}

/**
 * Exact arithmetic inverse of one fold (YUK-1053).
 *
 * The running mean is order-insensitive, so subtracting the recorded residual is exact.
 * The residual must be the one originally written; recomputing it live is wrong once θ̂
 * moved. Missing rows and already-empty counts revert idempotently. A folded record with
 * calibrated_n=0 signals drift and is handed to replay_required.
 */
export async function unfoldFamilyCalibration(
  tx: Tx,
  input: { record: FamilyFoldRecord; now: Date },
): Promise<'reverted' | 'drift'> {
  const existing = await getFamilyCalibration(tx, input.record.familyKey);
  if (existing === null) return 'reverted'; // Effect already gone; idempotent.
  const newN = Math.max(0, existing.evidence_count - 1);
  let newCalibratedN = existing.calibrated_n;
  let storedDelta = existing.b_delta;
  let storedConfidence = existing.confidence;
  if (input.record.folded) {
    if (existing.calibrated_n <= 0) return 'drift';
    newCalibratedN = existing.calibrated_n - 1;
    if (newCalibratedN === 0) {
      storedDelta = 0;
      storedConfidence = 0;
    } else {
      const rawMean = existing.b_delta / shrinkageFactor(existing.calibrated_n);
      const prevRawMean =
        (rawMean * existing.calibrated_n - input.record.residual) / newCalibratedN;
      storedConfidence = shrinkageFactor(newCalibratedN);
      storedDelta = shrinkFamilyDelta(prevRawMean, newCalibratedN);
    }
  }
  await tx
    .update(item_family_calibration)
    .set({
      b_delta: storedDelta,
      evidence_count: newN,
      confidence: storedConfidence,
      calibrated_n: newCalibratedN,
      updated_at: input.now,
    })
    .where(eq(item_family_calibration.family_key, input.record.familyKey));
  return 'reverted';
}

// Hook: derive the family key and inputs for one objective attempt, then update.
//
// theta must be the PRE-attempt value. This runs after updateThetaForAttempt, so reading
// mastery_state here would use the posterior and bias every residual. The anchor mirrors
// the θ̂ write path (hard anchor, else weak difficulty proxy). The caller swallows
// failures; the single upsert leaves no partial state on its own.

export interface RecordFamilyObservationInput {
  /** Question's primary knowledge (q.knowledge_ids[0]); no primary means no family key. */
  primaryKnowledgeId: string | null | undefined;
  /** question.id — used only for the anchor and distinct count, never in family_key. */
  questionId: string;
  kind: string;
  source: string;
  /** Weak-anchor fallback when no calibrated b exists. */
  difficulty: number;
  /** Clean binary outcome: success=1 / failure=0. Never coerce partial into 1. */
  outcome: 0 | 1;
  /**
   * Raw attempt outcome. 'partial' is skipped: treating half-correct as 1 would create a
   * spurious "family is easier" bias. Absent means the caller has no partial state.
   */
  attemptOutcome?: 'success' | 'failure' | 'partial';
  /** Judge route; null/non-objective is skipped. */
  judgeRoute: string | null | undefined;
  /**
   * Pre-attempt θ̂. Must be captured before updateThetaForAttempt; reading mastery_state
   * here would use the posterior. Undefined falls back for legacy callers only.
   */
  thetaBefore?: number;
  now: Date;
}

export async function recordFamilyObservationForAttempt(
  tx: Tx,
  input: RecordFamilyObservationInput,
): Promise<FamilyFoldRecord | null> {
  const primaryKnowledgeId = input.primaryKnowledgeId?.trim();
  if (!primaryKnowledgeId) return null;

  // Gate (a): reject before touching the DB.
  if (!isObjectiveJudgeRoute(input.judgeRoute)) return null;

  // Partial is not a clean objective observation; it would bias the residual toward
  // "family is easier" and must not even increment evidence_count.
  if (input.attemptOutcome === 'partial') return null;

  // family-key.ts owns subject derivation and the orphan → 'unknown' fallback.
  const key = await resolveFamilyKeyForQuestion(tx, {
    primaryKnowledgeId,
    kind: input.kind,
    source: input.source,
  });
  if (key === null) return null;

  // Same anchor chain as the θ̂ update.
  const calRows = await tx
    .select({ b: item_calibration.b })
    .from(item_calibration)
    .where(
      and(eq(item_calibration.question_id, input.questionId), eq(item_calibration.track, 'hard')),
    )
    .limit(1);
  const calB = calRows[0]?.b ?? null;
  const bAnchor = calB ?? difficultyToLogitB(input.difficulty);
  // Weak anchors are down-weighted, matching the θ̂ update's bWeight.
  const anchorWeight = calB !== null ? 1 : DIFFICULTY_PROXY_WEIGHT;

  // Prefer the caller's pre-attempt θ̂; fall back to mastery_state only for legacy callers.
  let theta: number;
  if (input.thetaBefore !== undefined) {
    theta = input.thetaBefore;
  } else {
    const stateRows = await tx
      .select({ theta_hat: mastery_state.theta_hat })
      .from(mastery_state)
      .where(
        and(
          eq(mastery_state.subject_kind, 'knowledge'),
          eq(mastery_state.subject_id, primaryKnowledgeId),
        ),
      )
      .limit(1);
    theta = stateRows[0]?.theta_hat ?? 0;
  }

  // Distinct questions behind the family's live observations, not the question pool: one
  // repeatedly drilled question must not pass the gate. The current one is not receipted yet.
  const observedQuestionIds = await liveFamilyObservationQuestionIds(tx, key);
  observedQuestionIds.add(input.questionId);

  return updateFamilyCalibration(tx, {
    familyKey: key,
    theta,
    bAnchor,
    outcome: input.outcome,
    isObjective: true,
    distinctQuestionCount: observedQuestionIds.size,
    anchorWeight,
    now: input.now,
  });
}
