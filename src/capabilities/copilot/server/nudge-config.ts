// Copilot 主动开口触发线配置：每日可见上限 + 过期窗。

import { getConfigMany } from '@/core/config/store';

export interface NudgeConfig {
  /** 全局每日上限（best-effort 软上限——TOCTOU）。仅数非 shadow（可见）nudge。 */
  dailyMax: number;
  /** nudge 过期窗（小时）——过期后读模型静默过滤，不删行。 */
  expiresHours: number;
}

export function loadNudgeConfig(env: NodeJS.ProcessEnv = process.env): NudgeConfig {
  // DB > env > code-default；env 层无效值由 registry envParse 回落到默认。
  const cfg = getConfigMany(['COPILOT_NUDGE_DAILY_MAX', 'COPILOT_NUDGE_EXPIRES_HOURS'], env);
  return {
    dailyMax: typeof cfg.COPILOT_NUDGE_DAILY_MAX === 'number' ? cfg.COPILOT_NUDGE_DAILY_MAX : 3,
    expiresHours:
      typeof cfg.COPILOT_NUDGE_EXPIRES_HOURS === 'number' ? cfg.COPILOT_NUDGE_EXPIRES_HOURS : 24,
  };
}
