// Learner-facing wording for the overnight band. The window length is owned by the
// digest read model (last activity day → today, capped); this module only names it.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OvernightBandCopy {
  title: string;
  quiet: string;
  toggle: string;
}

export interface OvernightCostCopy {
  label: string;
  quiet: string;
}

const QUIET_TAIL = ' —— 团队会在你持续学习后，开始为你做夜间复盘。';

/** Whole days between the digest window bounds; 1 when the payload is not parseable. */
export function overnightWindowDayCount(window: { from: string; to: string }): number {
  const span = Date.parse(window.to) - Date.parse(window.from);
  if (!Number.isFinite(span)) return 1;
  return Math.max(1, Math.round(span / DAY_MS));
}

export function overnightBandCopy(days: number): OvernightBandCopy {
  if (days > 1) {
    const span = `你不在的这 ${days} 天`;
    return {
      title: `${span}，AI 替你做了什么`,
      quiet: `${span}里没有需要交班的活动${QUIET_TAIL}`,
      toggle: `${span}里，AI 还替你做了这些`,
    };
  }
  return {
    title: '昨夜 AI 替你做了什么',
    quiet: `昨夜没有需要交班的活动${QUIET_TAIL}`,
    toggle: '昨夜 AI 还替你做了这些',
  };
}

export function overnightCostCopy(days: number): OvernightCostCopy {
  if (days > 1) {
    return {
      label: '这几天 AI 用量与费用',
      quiet: '这几天暂无费用记录，不代表实际费用为零。',
    };
  }
  return {
    label: '昨日 AI 用量与费用',
    quiet: '昨日暂无费用记录，不代表实际费用为零。',
  };
}
