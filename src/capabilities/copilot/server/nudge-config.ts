// Copilot 主动开口触发线配置。
//
// `COPILOT_NUDGE_ENABLED` 只 gate user-facing surfacing，不 gate 判定/写入：OFF（默认）时 handler
// 仍跑判定并写 payload.shadow=true 的证据 event；`GET /nudges` 必须排除 shadow 行，免翻 flag 时
// 倒出 backlog。

import { getConfigMany } from '@/core/config/store';

export interface NudgeConfig {
  /** 只 gate user-facing surfacing；false（默认）时仍写 shadow=true 证据行。 */
  enabled: boolean;
  /** 全局每日上限（best-effort 软上限——TOCTOU）。仅 gate 非 shadow（可见）nudge。 */
  dailyMax: number;
  /** nudge 过期窗（小时）——过期后读模型静默过滤，不删行。 */
  expiresHours: number;
}

export function loadNudgeConfig(env: NodeJS.ProcessEnv = process.env): NudgeConfig {
  // DB > env > code-default；env 层无效值由 registry envParse 回落到默认。
  const cfg = getConfigMany(
    ['COPILOT_NUDGE_ENABLED', 'COPILOT_NUDGE_DAILY_MAX', 'COPILOT_NUDGE_EXPIRES_HOURS'],
    env,
  );
  return {
    enabled: cfg.COPILOT_NUDGE_ENABLED === true,
    dailyMax: typeof cfg.COPILOT_NUDGE_DAILY_MAX === 'number' ? cfg.COPILOT_NUDGE_DAILY_MAX : 3,
    expiresHours:
      typeof cfg.COPILOT_NUDGE_EXPIRES_HOURS === 'number' ? cfg.COPILOT_NUDGE_EXPIRES_HOURS : 24,
  };
}
