// YUK-622 — daily practice 的用户时间预算与估时真相源。
//
// pace 是 onboarding/placement 已持久化的自述，只控制「今天排多少练习」，绝不进入
// theta / p(L) / FSRS。旧用户没有 pace 时按 medium=20 分钟处理。

export type DailyPracticePace = 'light' | 'medium' | 'dense';

export const DEFAULT_DAILY_PRACTICE_PACE: DailyPracticePace = 'medium';

export const DAILY_PRACTICE_BUDGET_MINUTES: Readonly<Record<DailyPracticePace, number>> = {
  light: 10,
  medium: 20,
  dense: 40,
};

export const QUESTION_ESTIMATED_MINUTES = 2;
export const PAPER_ESTIMATED_MINUTES = 10;

export function normalizeDailyPracticePace(pace: string | null | undefined): DailyPracticePace {
  if (pace === 'light' || pace === 'medium' || pace === 'dense') return pace;
  return DEFAULT_DAILY_PRACTICE_PACE;
}

export function dailyPracticeBudgetMinutes(pace: string | null | undefined): number {
  return DAILY_PRACTICE_BUDGET_MINUTES[normalizeDailyPracticePace(pace)];
}

export function estimateStreamItemMinutes(itemKind: 'question' | 'paper'): number {
  return itemKind === 'paper' ? PAPER_ESTIMATED_MINUTES : QUESTION_ESTIMATED_MINUTES;
}

export interface BudgetableStreamItem {
  item_kind: 'question' | 'paper';
  source: string;
}

export interface TimeBudgetResult<T> {
  kept: T[];
  estimatedMinutes: number;
  deferredDueCount: number;
  truncated: boolean;
}

/**
 * 按分钟预算选出今日流：先给最早到期题占位，再按原意图序填非到期题/卷。
 *
 * 这是确定性「保底/延后」规则：到期题超预算时，保留输入顺序中能装下的前缀，其余延后；
 * 非到期项只使用剩余预算。最终输出恢复原意图序，所以 legacy 的 variant 穿插仍保持。
 */
export function fitStreamToTimeBudget<T extends BudgetableStreamItem>(
  items: readonly T[],
  budgetMinutes: number | undefined,
): TimeBudgetResult<T> {
  if (budgetMinutes === undefined) {
    return {
      kept: [...items],
      estimatedMinutes: items.reduce(
        (sum, item) => sum + estimateStreamItemMinutes(item.item_kind),
        0,
      ),
      deferredDueCount: 0,
      truncated: false,
    };
  }
  if (!Number.isInteger(budgetMinutes) || budgetMinutes < 1) {
    throw new Error(`daily practice budget must be a positive integer (got ${budgetMinutes})`);
  }

  let remaining = budgetMinutes;
  let deferredDueCount = 0;
  const selectedIndexes = new Set<number>();

  for (const [index, item] of items.entries()) {
    if (item.source !== 'decay') continue;
    const cost = estimateStreamItemMinutes(item.item_kind);
    if (cost <= remaining) {
      selectedIndexes.add(index);
      remaining -= cost;
    } else {
      deferredDueCount++;
    }
  }

  for (const [index, item] of items.entries()) {
    if (item.source === 'decay') continue;
    const cost = estimateStreamItemMinutes(item.item_kind);
    if (cost <= remaining) {
      selectedIndexes.add(index);
      remaining -= cost;
    }
  }

  const kept = items.filter((_, index) => selectedIndexes.has(index));
  return {
    kept,
    estimatedMinutes: budgetMinutes - remaining,
    deferredDueCount,
    truncated: kept.length < items.length,
  };
}
