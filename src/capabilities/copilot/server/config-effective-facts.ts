// YUK-1007 — copilot 拥有键的 consumer-effective 事实（真实 reader 调用）。
// 经 copilot/public.ts 透出给组合根 facts seam。
import type { ConfigEffectiveFacts } from '@/core/config/effective';
import { loadNudgeConfig } from './nudge-config';

export function copilotConfigEffectiveFacts(): ConfigEffectiveFacts {
  const nudge = loadNudgeConfig();
  return {
    COPILOT_NUDGE_DAILY_MAX: { value: nudge.dailyMax },
    COPILOT_NUDGE_EXPIRES_HOURS: { value: nudge.expiresHours },
    COPILOT_NUDGE_STREAK_N: { value: nudge.streakN },
    COPILOT_NUDGE_KC_COOLDOWN_HOURS: { value: nudge.kcCooldownHours },
  };
}
