// Effective values from the real readers, exposed to the config facts seam.
import type { ConfigEffectiveFacts } from '@/core/config/effective';
import { matchThreshold } from '@/kernel/read-models/knowledge-similarity';
import { dedupDistanceMax, dedupMaxPairs, dedupWindowDays } from './dedup-flags';

export function knowledgeConfigEffectiveFacts(): ConfigEffectiveFacts {
  return {
    KC_DEDUP_DISTANCE_MAX: { value: dedupDistanceMax() },
    KC_DEDUP_WINDOW_DAYS: { value: dedupWindowDays() },
    KC_DEDUP_MAX_PAIRS: { value: dedupMaxPairs() },
    TAGGING_MATCH_THRESHOLD: { value: matchThreshold() },
  };
}
