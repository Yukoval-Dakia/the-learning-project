import type { z } from 'zod';
import { type AssessmentVerdict, ratingForVerdict } from '@/core/schema/assessment/settlement';
import type { FsrsRating } from '@/core/schema/business';
import { resolveSrtTimeLimit } from '@/core/theta';

// Sealed by the server on first capture; absent/future versions retain legacy scheduling.
export const ATTEMPT_SCHEDULING_POLICY = 'confidence-speed-v1';

/** Population-seeded starting policy, separate from scoring and ability estimation. */
export function automaticSchedulingRating(input: {
  verdict: AssessmentVerdict;
  normalized: number | null;
  policy: unknown;
  difficulty: number | undefined;
  confidence: number | null;
  durationMs: number | null;
}): z.infer<typeof FsrsRating> | null {
  const fallback = ratingForVerdict(input.verdict);
  if (
    input.policy !== ATTEMPT_SCHEDULING_POLICY ||
    input.verdict !== 'correct' ||
    input.normalized !== 1
  )
    return fallback;

  const { difficulty, confidence, durationMs } = input;
  const referenceMs =
    difficulty !== undefined && Number.isInteger(difficulty) && difficulty >= 1 && difficulty <= 5
      ? resolveSrtTimeLimit(difficulty) * 1000
      : null;
  const knownSpeed =
    referenceMs !== null && durationMs !== null && Number.isFinite(durationMs) && durationMs > 0;
  if (confidence === 1 || confidence === 2 || (knownSpeed && durationMs >= 2 * referenceMs))
    return 'hard';
  if ((confidence === 4 || confidence === 5) && knownSpeed && durationMs <= 0.5 * referenceMs)
    return 'easy';
  return 'good';
}
