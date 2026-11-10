import { difficultyToLogitB } from '@/core/theta';
import { type DifficultyBand, difficultyBandFor } from '@/kernel/supply-contracts';

/** Inclusive 1–5 ordinals. Null when the band's logit window holds none of them. */
export interface DifficultyLevelSpan {
  min: number;
  max: number;
}

/**
 * The supply aim: relative band plus the 1–5 span inverted from it once.
 * Downstream passes this value and does not call the logit map again.
 */
export interface BandLevelTarget {
  band: DifficultyBand;
  levels: DifficultyLevelSpan | null;
}

const ORDINAL_LEVELS = [1, 2, 3, 4, 5] as const;

export function isDifficultyBand(value: string): value is DifficultyBand {
  return value === 'below' || value === 'near' || value === 'above' || value === 'stretch';
}

/**
 * Invert `band` at this learner's θ̂. Each ordinal's logit is `difficultyToLogitB`;
 * the cut is `difficultyBandFor`, the same one the scanner uses on pool items.
 * θ̂ = 0 is the cold-start anchor (near → 3, above → 4, stretch → 5, below → 1–2).
 * `above` is narrower than one ordinal step, so a high θ̂ can leave `levels` null.
 */
export function resolveBandLevelTarget(band: DifficultyBand, thetaHat: number): BandLevelTarget {
  const matched = ORDINAL_LEVELS.filter(
    (level) => difficultyBandFor(difficultyToLogitB(level), thetaHat) === band,
  );
  const first = matched[0];
  const last = matched[matched.length - 1];
  if (first === undefined || last === undefined) return { band, levels: null };
  return { band, levels: { min: first, max: last } };
}

export function difficultyInBand(difficulty: number, target: BandLevelTarget): boolean {
  const { levels } = target;
  if (!levels) return false;
  return difficulty >= levels.min && difficulty <= levels.max;
}

/**
 * Job payloads. `levels === undefined` is a legacy payload (resolve at θ̂ = 0).
 * `levels === null` is an explicit empty span and must not be re-resolved.
 */
export function bandLevelTargetFromPayload(
  band: string | null | undefined,
  levels: DifficultyLevelSpan | null | undefined,
): BandLevelTarget | null {
  if (!band || !isDifficultyBand(band)) return null;
  if (levels === undefined) return resolveBandLevelTarget(band, 0);
  if (levels === null || levels.min > levels.max) return { band, levels: null };
  return { band, levels: { min: levels.min, max: levels.max } };
}
