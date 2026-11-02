// Placement probe termination. Pure: no IO or DB.
//
// Stops at the count cap (the anti-fatigue ceiling) or early when every probed KC's θ̂
// standard error is at or below the threshold. SE comes from the live thetaSe(precision)
// function; nothing new is persisted. The caller passes each KC's theta_precision.

import { thetaSe } from '@/core/theta';

/**
 * Default hard count cap for a placement probe (owner-locked: fixed 8 questions per
 * subject — NOT dynamic). Owner-tunable module const, same class as the other selection
 * weights; the API handler uses it when the caller doesn't override `cap`.
 */
export const PLACEMENT_DEFAULT_CAP = 8;

// onboarding self-report `pace` → probe count cap ("每日量"). The learner's daily-
// budget knob (light/medium/dense) shortens or holds the probe length. Owner-supplied budget
// constants (same class as PLACEMENT_DEFAULT_CAP, NOT a fitted/cross-examinee parameter →
// n=1 admissible cat 1). The cap only bounds HOW MANY questions are asked; it never feeds
// θ̂/p(L)/FSRS.
// CEILING = PLACEMENT_DEFAULT_CAP (8). The placement UI (ScreenPlacement) renders a FIXED
// 8-segment progress track + a "last question" gate at CAP=8, so a cap ABOVE 8 would desync the
// UI. This lane therefore caps `dense` at the existing UI ceiling (8 = same as medium/default);
// raising `dense` above 8 needs a dynamic-cap UI (progress track + last-gate driven by the
// server cap), which is a UI change gated on a design pre-flight → tracked as a follow-up, NOT
// done here. `light` shortens the probe (the UI already supports early completion — the
// "答到 cap 或收敛即止" copy + the done handler land regardless of count).
export const PLACEMENT_PACE_CAP: Readonly<Record<string, number>> = {
  light: 5,
  medium: PLACEMENT_DEFAULT_CAP,
  dense: PLACEMENT_DEFAULT_CAP,
};

/**
 * Resolve the probe count cap from the learner's self-reported pace. Unknown/missing pace →
 * PLACEMENT_DEFAULT_CAP (back-compat: a probe started without a self-report behaves exactly as
 * before). Pure + total.
 */
export function capForPace(pace: string | null | undefined): number {
  if (pace != null && Object.hasOwn(PLACEMENT_PACE_CAP, pace)) {
    return PLACEMENT_PACE_CAP[pace];
  }
  return PLACEMENT_DEFAULT_CAP;
}

export interface PlacementTerminationInput {
  /** number of questions answered so far in this probe. */
  answeredCount: number;
  /** hard count ceiling (owner-locked: e.g. 8 per subject). Must be a positive integer. */
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
  // narrows `seThreshold` to `number` here (no `as number` assertion — OCR minor).
  if (
    typeof seThreshold === 'number' &&
    Number.isFinite(seThreshold) &&
    seThreshold > 0 &&
    perKcPrecision !== undefined &&
    perKcPrecision.length > 0
  ) {
    // Validate ALL entries in a pre-pass BEFORE the convergence check. Doing it inside
    // `.every` would let short-circuit skip entries after the first non-converged one,
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
