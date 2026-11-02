// Pure trend math (no DB or schema imports), shared with the read model.
//
// A trend is never a raw delta: it reports a qualitative direction and confidence, so
// noise is not drawn as a certain rise. Minimum events gate any direction; high
// confidence needs twice that because a trend is a delta of deltas. Holding is a
// theta-mean difference inside the band; otherwise effect size must clear the noise
// thresholds for medium/high.
export const MIN_EVENTS_FOR_TREND = 4;
export const FIRM_TREND_EVIDENCE = 8;
export const HOLDING_BAND_THETA = 0.05;
export const EFFECT_RATIO_MEDIUM = 0.5;
export const EFFECT_RATIO_HIGH = 1.0;

// Rollup confidence: share agreeing with the dominant direction.
export const ROLLUP_AGREE_HIGH = 0.75;
export const ROLLUP_AGREE_MEDIUM = 0.5;

export type TrendDirection = 'rising' | 'holding' | 'falling' | 'insufficient';
export type TrendConfidence = 'low' | 'medium' | 'high';

/** One mastery-progress point. Missing or non-numeric payload fields are null. */
export interface EffectivenessTrendPoint {
  at: string;
  p_learned: number | null;
  /** Absolute theta, the anchor for the trend. */
  theta_hat: number | null;
  /** Null before the first attempt. Never displayed raw. */
  theta_delta: number | null;
}

export interface EffectivenessTrendSummary {
  direction: TrendDirection;
  confidence: TrendConfidence;
  /** Number of attempts with a usable theta. */
  span_evidence: number;
  /** False means show an activity proxy instead of pretending mastery moved. */
  has_mastery_signal: boolean;
}

export function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Population standard deviation; zero for fewer than two points. */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

/**
 * Compare equal-size early and late theta windows. Theta is used rather than p(L)
 * because sigmoid compresses equal gains unevenly near 0 and 1. Direction is the
 * window difference; confidence is sample size plus effect over noise, so holding
 * can be confidently flat while a weak rise stays low.
 */
export function summarizeTrend(points: EffectivenessTrendPoint[]): EffectivenessTrendSummary {
  const thetas = points.map((p) => p.theta_hat).filter((t): t is number => t !== null);
  const n = thetas.length;

  if (n < MIN_EVENTS_FOR_TREND) {
    // Insufficient is a first-class state, including an all-null theta.
    return {
      direction: 'insufficient',
      confidence: 'low',
      span_evidence: n,
      has_mastery_signal: false,
    };
  }

  const half = Math.floor(n / 2);
  const earlyMean = mean(thetas.slice(0, half));
  const nearMean = mean(thetas.slice(n - half));
  const diff = nearMean - earlyMean;
  const sd = stddev(thetas);
  // Effect over noise; a zero spread with a nonzero difference is certain.
  const ratio = sd > 0 ? Math.abs(diff) / sd : Math.abs(diff) > 0 ? Number.POSITIVE_INFINITY : 0;

  let direction: TrendDirection;
  if (Math.abs(diff) <= HOLDING_BAND_THETA) {
    direction = 'holding';
  } else {
    direction = diff > 0 ? 'rising' : 'falling';
  }

  let confidence: TrendConfidence;
  if (direction === 'holding') {
    confidence = n >= FIRM_TREND_EVIDENCE ? 'high' : 'medium';
  } else if (n >= FIRM_TREND_EVIDENCE && ratio >= EFFECT_RATIO_HIGH) {
    confidence = 'high';
  } else if (ratio >= EFFECT_RATIO_MEDIUM) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return { direction, confidence, span_evidence: n, has_mastery_signal: true };
}

/**
 * Pick the dominant direction across credible KC trends. No credible KCs means
 * insufficient, so the UI uses an activity proxy. Confidence combines agreement
 * share with the credible count.
 */
export function rollupSubjectDirection(trends: EffectivenessTrendSummary[]): {
  direction: TrendDirection;
  confidence: TrendConfidence;
} {
  const credible = trends.filter((t) => t.has_mastery_signal);
  if (credible.length === 0) {
    return { direction: 'insufficient', confidence: 'low' };
  }
  const counts: Record<'rising' | 'holding' | 'falling', number> = {
    rising: 0,
    holding: 0,
    falling: 0,
  };
  for (const t of credible) {
    if (t.direction === 'rising' || t.direction === 'holding' || t.direction === 'falling') {
      counts[t.direction] += 1;
    }
  }
  // Deterministic tiebreak: rising, then holding, then falling.
  const order: Array<'rising' | 'holding' | 'falling'> = ['rising', 'holding', 'falling'];
  let direction: 'rising' | 'holding' | 'falling' = order[0];
  for (const d of order) {
    if (counts[d] > counts[direction]) direction = d;
  }
  const agree = counts[direction] / credible.length;
  let confidence: TrendConfidence;
  if (credible.length >= MIN_EVENTS_FOR_TREND && agree >= ROLLUP_AGREE_HIGH) {
    confidence = 'high';
  } else if (agree >= ROLLUP_AGREE_MEDIUM) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }
  return { direction, confidence };
}
