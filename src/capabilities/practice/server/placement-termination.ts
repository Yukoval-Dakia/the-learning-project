// Placement probe termination — PURE (no IO, no DB). cold-start inc-B (YUK-468).
// docs/design/2026-06-20-cold-start-day-one-design.md §2 步骤3 行 154 / §6 Q1.
//
// Decides when a bounded placement probe stops. Two conditions:
//   1. count cap (§6 Q1: ~8 题/科 fixed — the hard 防疲劳 ceiling)
//   2. optional θ SE convergence (early stop — "SE 收够即停"): when every probed KC's
//      θ̂ standard error has fallen to/below a threshold, the estimate is precise enough
//      and we stop EARLY (below the cap) to save the learner questions.
//
// SE is derived from the SAME thetaSe(precision) the live θ̂ engine uses (theta.ts:397,
// SE = 1/√precision) — no new schema, no SE persistence. The caller reads each probed KC's
// mastery_state.theta_precision and passes them in.

import { thetaSe } from '@/core/theta';

export interface PlacementTerminationInput {
  /** number of questions answered so far in this probe. */
  answeredCount: number;
  /** hard count ceiling (§6 Q1: e.g. 8 per subject). Must be a positive integer. */
  cap: number;
  /**
   * Per-probed-KC θ precision (mastery_state.theta_precision). Optional — when omitted or
   * empty, SE convergence is NOT evaluated (cap is the only stop). The SE early-stop fires
   * only when seThreshold is a finite positive number AND this list is non-empty AND every
   * entry's thetaSe(precision) <= seThreshold.
   */
  perKcPrecision?: readonly number[];
  /**
   * θ SE early-stop threshold. null/undefined (default) disables SE convergence → only the
   * count cap stops the probe. A finite positive value enables the early stop.
   */
  seThreshold?: number | null;
}

export type PlacementTerminationReason = 'cap' | 'se_converged';

export interface PlacementTerminationResult {
  shouldStop: boolean;
  /** the binding reason when shouldStop; null while the probe continues. */
  reason: PlacementTerminationReason | null;
}

/**
 * Evaluate whether a placement probe should stop after the latest answer.
 *
 * Precedence: the count cap is the hard ceiling (checked FIRST so the probe NEVER exceeds
 * it); SE convergence is an early stop that only matters while answeredCount < cap. When
 * both would apply at the same step, 'cap' is reported (the probe was going to stop anyway).
 *
 * Pure + total: invalid inputs throw (a termination oracle must not silently mis-decide).
 */
export function evaluatePlacementTermination(
  input: PlacementTerminationInput,
): PlacementTerminationResult {
  const { answeredCount, cap, perKcPrecision, seThreshold } = input;

  if (!Number.isInteger(answeredCount) || answeredCount < 0) {
    throw new Error(
      `evaluatePlacementTermination: answeredCount must be an integer >= 0 (got ${answeredCount})`,
    );
  }
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`evaluatePlacementTermination: cap must be an integer >= 1 (got ${cap})`);
  }

  // 1. Hard cap ceiling — checked first so the probe can never overrun it.
  if (answeredCount >= cap) {
    return { shouldStop: true, reason: 'cap' };
  }

  // 2. Optional SE convergence early stop (below cap). The full guard is inlined so TS
  //    narrows `seThreshold` to `number` here (no `as number` assertion — OCR minor).
  if (
    typeof seThreshold === 'number' &&
    Number.isFinite(seThreshold) &&
    seThreshold > 0 &&
    perKcPrecision !== undefined &&
    perKcPrecision.length > 0
  ) {
    // Validate ALL entries in a pre-pass BEFORE the convergence check. Doing it inside
    // `.every()` would let short-circuit skip entries after the first non-converged one,
    // silently ignoring a later invalid value (OCR major) — a termination oracle must
    // throw on ANY invalid input, never silently mis-decide.
    for (const p of perKcPrecision) {
      if (!Number.isFinite(p) || p < 0) {
        throw new Error(
          `evaluatePlacementTermination: perKcPrecision entries must be finite >= 0 (got ${p})`,
        );
      }
    }
    const allConverged = perKcPrecision.every((p) => thetaSe(p) <= seThreshold);
    if (allConverged) {
      return { shouldStop: true, reason: 'se_converged' };
    }
  }

  return { shouldStop: false, reason: null };
}
