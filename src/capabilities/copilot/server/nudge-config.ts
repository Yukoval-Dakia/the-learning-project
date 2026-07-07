// YUK-577 — copilot 主动开口触发线配置。
// design: docs/design/2026-07-07-yuk577-proactive-triggers.md §3.2 / §3.7.
//
// SHADOW 模型（Q6：不用 blind-OFF）：`COPILOT_NUDGE_ENABLED` 只 gate **user-facing surfacing**，
// 不 gate 判定/写入。OFF（默认）时 handler 仍跑判定 + 写证据 event，但打 payload.shadow=true；
// `GET /nudges` 必须排除 shadow=true（免翻 flag 时倒出 backlog）。owner 读 shadow 行校准参数后
// 再翻 surfacing。shadow 行 = 暗窗期 live consumer，直接消解「建成不通电」。

export interface NudgeConfig {
  /** surfacing gate。true = 翻开 user-facing；false（默认）= shadow 期，写 shadow=true 证据行。 */
  enabled: boolean;
  /** 全局每日上限（best-effort 软上限，非硬保证——TOCTOU §3.2）。仅 gate 非 shadow（可见）nudge。 */
  dailyMax: number;
  /** nudge 过期窗（小时）——过期后读模型静默过滤，不删行（A3「可静默消失」）。 */
  expiresHours: number;
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadNudgeConfig(env: NodeJS.ProcessEnv = process.env): NudgeConfig {
  return {
    // 严格 '1' —— 与仓内 flag 纪律一致（theta-grid / judge_calibration 等 kill-switch 先例）。
    enabled: env.COPILOT_NUDGE_ENABLED === '1',
    dailyMax: parseIntEnv(env.COPILOT_NUDGE_DAILY_MAX, 3),
    expiresHours: parseIntEnv(env.COPILOT_NUDGE_EXPIRES_HOURS, 24),
  };
}
