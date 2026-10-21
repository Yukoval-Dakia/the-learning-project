// Thresholds for the nightly dedup scan. Merges are destructive and stay behind a
// human accept, so these only decide what to propose, not what to merge.

/**
 * Cosine distance ceiling for a near-duplicate pair. Much tighter than the tagging
 * threshold because a merge is destructive; the tight ceiling keeps the inbox
 * signal-dense. Untuned on a real corpus.
 */
const DEFAULT_DEDUP_DISTANCE_MAX = 0.1;

/** Recent-mint lookback in days, which bounds scan cost. */
const DEFAULT_DEDUP_WINDOW_DAYS = 7;

/** Per-run proposal cap; leftovers wait for later runs as the window moves. */
const DEFAULT_DEDUP_MAX_PAIRS = 50;

import { getConfig } from '@/core/config/store';

export function dedupDistanceMax(): number {
  // DB, then env, then the default. A non-positive ceiling would disable dedup.
  const v = getConfig('KC_DEDUP_DISTANCE_MAX');
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_DEDUP_DISTANCE_MAX;
}

export function dedupWindowDays(): number {
  const v = getConfig('KC_DEDUP_WINDOW_DAYS');
  const n = typeof v === 'number' ? Math.trunc(v) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_DEDUP_WINDOW_DAYS;
}

export function dedupMaxPairs(): number {
  const v = getConfig('KC_DEDUP_MAX_PAIRS');
  const n = typeof v === 'number' ? Math.trunc(v) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_DEDUP_MAX_PAIRS;
}
