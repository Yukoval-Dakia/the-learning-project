// YUK-577 — copilot 主动开口触发线配置。
// design: docs/design/2026-07-07-yuk577-proactive-triggers.md §3.2 / §3.7.
//
// SHADOW 模型（Q6：不用 blind-OFF）：`COPILOT_NUDGE_ENABLED` 只 gate **user-facing surfacing**，
// 不 gate 判定/写入。OFF（默认）时 handler 仍跑判定 + 写证据 event，但打 payload.shadow=true；
// `GET /nudges` 必须排除 shadow=true（免翻 flag 时倒出 backlog）。owner 读 shadow 行校准参数后
// 再翻 surfacing。shadow 行 = 暗窗期 live consumer，直接消解「建成不通电」。

import { getConfigMany } from '@/core/config/store';

export interface NudgeConfig {
  /** surfacing gate。true = 翻开 user-facing；false（默认）= shadow 期，写 shadow=true 证据行。 */
  enabled: boolean;
  /** 全局每日上限（best-effort 软上限，非硬保证——TOCTOU §3.2）。仅 gate 非 shadow（可见）nudge。 */
  dailyMax: number;
  /** nudge 过期窗（小时）——过期后读模型静默过滤，不删行（A3「可静默消失」）。 */
  expiresHours: number;
  /** 同 KC 连错达到该次数才触发。 */
  streakN: number;
  /** 同 KC streak nudge 冷却窗（小时）。 */
  kcCooldownHours: number;
}

export function loadNudgeConfig(env: NodeJS.ProcessEnv = process.env): NudgeConfig {
  // YUK-1007：五键经 getConfigMany（DB > env > code-default；env 层保留原
  // parseIntEnv 语义——无效 → fallback 已由 registry envParse 表达）。
  const cfg = getConfigMany(
    [
      'COPILOT_NUDGE_ENABLED',
      'COPILOT_NUDGE_DAILY_MAX',
      'COPILOT_NUDGE_EXPIRES_HOURS',
      'COPILOT_NUDGE_STREAK_N',
      'COPILOT_NUDGE_KC_COOLDOWN_HOURS',
    ],
    env,
  );
  return {
    enabled: cfg.COPILOT_NUDGE_ENABLED === true,
    dailyMax: typeof cfg.COPILOT_NUDGE_DAILY_MAX === 'number' ? cfg.COPILOT_NUDGE_DAILY_MAX : 3,
    expiresHours:
      typeof cfg.COPILOT_NUDGE_EXPIRES_HOURS === 'number' ? cfg.COPILOT_NUDGE_EXPIRES_HOURS : 24,
    streakN: typeof cfg.COPILOT_NUDGE_STREAK_N === 'number' ? cfg.COPILOT_NUDGE_STREAK_N : 3,
    kcCooldownHours:
      typeof cfg.COPILOT_NUDGE_KC_COOLDOWN_HOURS === 'number'
        ? cfg.COPILOT_NUDGE_KC_COOLDOWN_HOURS
        : 24,
  };
}
