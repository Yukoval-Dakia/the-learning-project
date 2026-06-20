import type { JudgeResultV2T } from '@/core/schema/capability';

/**
 * A9 (YUK-438) — steps@1 per-rubric-step evidence extraction.
 *
 * One open-ended attempt → N fixed partial-binarized step credits (typically 3–6),
 * each fed as a separate θ/PFA observation (FLAT multiplier: same KC set per step).
 *
 * FIXED mapping (D5b): partial → 0.5 via conjunctiveCreditsContinuous — never fit
 * per-step polytomous curves (GPCM n=1 trap). Values mirror steps-judge VERDICT_WEIGHT.
 */
export type StepSignalVerdict = 'correct' | 'partial' | 'wrong' | 'skipped';

export const STEP_SIGNAL_VERDICT_OUTCOME: Record<StepSignalVerdict, 0 | 0.5 | 1> = {
  correct: 1,
  partial: 0.5,
  wrong: 0,
  skipped: 0,
};

export interface StepGradingObservation {
  signal_idx: number;
  verdict: StepSignalVerdict;
  /** FIXED partial-binarize credit for conjunctiveCreditsContinuous. */
  continuousCredit: 0 | 0.5 | 1;
}

const STEP_SIGNAL_VERDICTS = new Set<string>(['correct', 'partial', 'wrong', 'skipped']);

function isStepSignalVerdict(v: unknown): v is StepSignalVerdict {
  return typeof v === 'string' && STEP_SIGNAL_VERDICTS.has(v);
}

function readSignalVerdicts(
  evidence: Record<string, unknown> | undefined,
): Array<{ signal_idx: number; verdict: StepSignalVerdict }> | null {
  const raw = evidence?.signal_verdicts;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const out: Array<{ signal_idx: number; verdict: StepSignalVerdict }> = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null;
    const rec = entry as { signal_idx?: unknown; verdict?: unknown };
    if (typeof rec.signal_idx !== 'number' || !Number.isInteger(rec.signal_idx)) return null;
    if (!isStepSignalVerdict(rec.verdict)) return null;
    out.push({ signal_idx: rec.signal_idx, verdict: rec.verdict });
  }
  return out;
}

/**
 * Extract per-step observations from a steps_v1_weighted judge result.
 * Returns null when the result is not step-gradable (unsupported, accelerator path, etc.).
 */
export function extractStepGradingObservations(
  result: JudgeResultV2T,
): StepGradingObservation[] | null {
  if (result.score_meaning !== 'steps_v1_weighted') return null;
  if (result.coarse_outcome === 'unsupported') return null;

  const verdicts = readSignalVerdicts(result.evidence_json);
  if (verdicts === null || verdicts.length === 0) return null;

  return verdicts.map(({ signal_idx, verdict }) => ({
    signal_idx,
    verdict,
    continuousCredit: STEP_SIGNAL_VERDICT_OUTCOME[verdict],
  }));
}

/** Gate helper — all three must hold before N× θ updates replace the single binary update. */
export function shouldApplyStepGradingTheta(
  enabled: boolean,
  judgeCalibrated: boolean,
  observations: StepGradingObservation[] | null,
): observations is StepGradingObservation[] {
  return enabled && judgeCalibrated && observations !== null && observations.length > 0;
}
