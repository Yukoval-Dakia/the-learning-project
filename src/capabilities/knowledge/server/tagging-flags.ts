// Tagging thresholds, overridable per environment. Read through a function so tests
// can mock the config binding.

/**
 * Cosine distance ceiling for a match. The query embeds the full question while KCs
 * embed name and domain, so distances run higher than a symmetric compare; the quiz
 * matcher's 0.35 was too tight here and matched nothing in the probe. 0.55 sits inside
 * the correct band but is still untuned on a real corpus. Too tight creates duplicates
 * (dedup catches them); too loose is a wrong match, which is rarer.
 */
const DEFAULT_MATCH_THRESHOLD = 0.55;

import { getConfig } from '@/core/config/store';

export function matchThreshold(): number {
  // DB, then env, then the default. Non-finite values fall back.
  const v = getConfig('TAGGING_MATCH_THRESHOLD');
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_MATCH_THRESHOLD;
}

/**
 * Global retrieval window before the subject filter runs, so an in-domain KC ranked
 * past it is invisible. Shared with the calibration replay.
 */
export const RETRIEVAL_TOP_K = 10;
