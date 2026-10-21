// Effective values from the real readers, exposed to the config facts seam.
import type { ConfigEffectiveFacts } from '@/core/config/effective';
import { dedupDistanceMax, dedupMaxPairs, dedupWindowDays } from './dedup-flags';
import { matchThreshold } from './tagging-flags';

export function knowledgeConfigEffectiveFacts(): ConfigEffectiveFacts {
  return {
    KC_DEDUP_DISTANCE_MAX: { value: dedupDistanceMax() },
    KC_DEDUP_WINDOW_DAYS: { value: dedupWindowDays() },
    KC_DEDUP_MAX_PAIRS: { value: dedupMaxPairs() },
    TAGGING_MATCH_THRESHOLD: { value: matchThreshold() },
  };
}
