// A9 (YUK-438) — step-grading θ wiring (B2 caller seam + B3 judge-calibration gate).

import {
  STEP_GRADING_EVIDENCE_ENABLED,
  STEP_GRADING_JUDGE_CONFIDENCE_FLOOR,
} from '@/capabilities/practice/server/step-grading-config';
import type { JudgeResultV2T } from '@/core/schema/capability';
import {
  type StepGradingObservation,
  extractStepGradingObservations,
  shouldApplyStepGradingTheta,
} from '@/core/step-grading-evidence';
import type { Tx } from '@/db/client';
import { item_calibration } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { type UpdateThetaForAttemptInput, updateThetaForAttempt } from './state';

/**
 * B3 — hard gate: step observations may feed θ only when the question's hard-track
 * item_calibration has a firm judge anchor (b set + confidence floor). Mirrors B5
 * admissibility: uncalibrated judge output is withheld from θ (owner review path).
 */
export async function isStepGradingJudgeCalibrated(tx: Tx, questionId: string): Promise<boolean> {
  const [row] = await tx
    .select({
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      confidence: item_calibration.confidence,
    })
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  if (!row) return false;
  const hasAnchor = row.b !== null || row.b_anchor !== null;
  const confidence = row.confidence ?? 0;
  return hasAnchor && confidence >= STEP_GRADING_JUDGE_CONFIDENCE_FLOOR;
}

/** N sequential updateThetaForAttempt calls — one per rubric step (FLAT KC multiplier). */
export async function applyStepGradingThetaUpdates(
  tx: Tx,
  base: Omit<UpdateThetaForAttemptInput, 'outcome' | 'continuousCredit'>,
  observations: StepGradingObservation[],
): Promise<void> {
  for (const obs of observations) {
    await updateThetaForAttempt(tx, {
      ...base,
      outcome: obs.continuousCredit >= 0.5 ? 1 : 0,
      continuousCredit: obs.continuousCredit,
    });
  }
}

/**
 * Collapse seam: either N per-step θ updates (flag ON + B3 gate + steps verdicts) or
 * the legacy single binary updateThetaForAttempt (flag-off byte-identical default).
 */
export async function updateThetaForAttemptWithOptionalStepGrading(
  tx: Tx,
  input: UpdateThetaForAttemptInput,
  judgeResult: JudgeResultV2T | null | undefined,
): Promise<void> {
  const observations =
    judgeResult !== null && judgeResult !== undefined
      ? extractStepGradingObservations(judgeResult)
      : null;

  if (!STEP_GRADING_EVIDENCE_ENABLED || observations === null) {
    await updateThetaForAttempt(tx, input);
    return;
  }

  const calibrated = await isStepGradingJudgeCalibrated(tx, input.questionId);
  if (!shouldApplyStepGradingTheta(STEP_GRADING_EVIDENCE_ENABLED, calibrated, observations)) {
    await updateThetaForAttempt(tx, input);
    return;
  }

  const { outcome: _legacyOutcome, continuousCredit: _legacyContinuous, ...base } = input;
  await applyStepGradingThetaUpdates(tx, base, observations);
}
