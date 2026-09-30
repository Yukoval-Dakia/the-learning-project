// YUK-1007 — knowledge 拥有键的 consumer-effective 事实（真实 reader 调用，
// 不复述防御性 fallback 规则）。经 knowledge/public.ts 透出给组合根 facts seam。
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
