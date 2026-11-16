// daily practice 的用户时间预算与估时真相源。
// pace 是 onboarding/placement 已持久化的自述，只控制「今天排多少练习」，绝不进入
// theta / p(L) / FSRS。旧用户没有 pace 时按 medium=20 分钟处理。

import { DEFAULT_QUESTION_MINUTES } from '@/core/daily-review-plan';

export type DailyPracticePace = 'light' | 'medium' | 'dense';

export const DEFAULT_DAILY_PRACTICE_PACE: DailyPracticePace = 'medium';

export const DAILY_PRACTICE_BUDGET_MINUTES: Readonly<Record<DailyPracticePace, number>> = {
  light: 10,
  medium: 20,
  dense: 40,
};

export const PAPER_ESTIMATED_MINUTES = 10;

export function normalizeDailyPracticePace(pace: string | null | undefined): DailyPracticePace {
  if (pace === 'light' || pace === 'medium' || pace === 'dense') return pace;
  return DEFAULT_DAILY_PRACTICE_PACE;
}

export function dailyPracticeBudgetMinutes(pace: string | null | undefined): number {
  return DAILY_PRACTICE_BUDGET_MINUTES[normalizeDailyPracticePace(pace)];
}

export function estimateStreamItemMinutes(
  itemKind: 'question' | 'paper',
  questionMinutes: number = DEFAULT_QUESTION_MINUTES,
): number {
  return itemKind === 'paper' ? PAPER_ESTIMATED_MINUTES : questionMinutes;
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

export interface TimeBudgetOptions {
  /** Withhold this many question slots from due items even when this list has no non-due rows. */
  reserveQuestionSlots?: number;
}

const NON_DUE_FLOOR_RATIO = 0.15;
const NON_DUE_FLOOR_MIN = 1;
const NON_DUE_FLOOR_MAX = 2;

/** 1–2 question slots, about 15% of the day's question capacity, when candidates exist. */
export function nonDueQuestionFloor(questionSlots: number, candidateCount: number): number {
  if (candidateCount <= 0 || !Number.isFinite(questionSlots) || questionSlots <= 0) return 0;
  const raw = Math.round(questionSlots * NON_DUE_FLOOR_RATIO);
  const desired = Math.min(NON_DUE_FLOOR_MAX, Math.max(NON_DUE_FLOOR_MIN, raw));
  return Math.min(desired, candidateCount, questionSlots);
}

function isNewLearningSource(source: string): boolean {
  return source === 'new_check' || source === 'frontier';
}

/**
 * 按分钟预算选出今日流：先保留产品已批准的干预交付，再给最容易忘的到期题占位，
 * 有非到期候选时留出 1–2 题（约 15%）给新学（没有新学候选时给其他非到期题）。
 * 装不下的到期题是输入顺序尾部，调用方须把到期段排成可回忆概率升序，尾部即最不容易忘的。
 *
 * 干预交付是承重产品动作，即使使当天流超过自述预算也不可静默丢弃。
 * 最终输出恢复原意图序，所以 legacy 的 variant 穿插仍保持。
 * 没有分钟预算时保留全部输入（旧调用方）。
 */
export function fitStreamToTimeBudget<T extends BudgetableStreamItem>(
  items: readonly T[],
  budgetMinutes: number | undefined,
  questionMinutes: number = DEFAULT_QUESTION_MINUTES,
  options?: TimeBudgetOptions,
): TimeBudgetResult<T> {
  if (budgetMinutes === undefined) {
    return {
      kept: [...items],
      estimatedMinutes: items.reduce(
        (sum, item) => sum + estimateStreamItemMinutes(item.item_kind, questionMinutes),
        0,
      ),
      deferredDueCount: 0,
      truncated: false,
    };
  }
  if (!Number.isInteger(budgetMinutes) || budgetMinutes < 1) {
    throw new Error(`daily practice budget must be a positive integer (got ${budgetMinutes})`);
  }

  const questionCost = estimateStreamItemMinutes('question', questionMinutes);
  const selectedIndexes = new Set<number>();
  let remaining = budgetMinutes;

  for (const [index, item] of items.entries()) {
    if (item.source !== 'intervention') continue;
    selectedIndexes.add(index);
    remaining = Math.max(0, remaining - estimateStreamItemMinutes(item.item_kind, questionMinutes));
  }

  const newLearningIndexes: number[] = [];
  const otherNonDueIndexes: number[] = [];
  for (const [index, item] of items.entries()) {
    if (selectedIndexes.has(index) || item.item_kind !== 'question') continue;
    if (item.source === 'decay' || item.source === 'intervention') continue;
    if (isNewLearningSource(item.source)) newLearningIndexes.push(index);
    else otherNonDueIndexes.push(index);
  }
  const preferred = newLearningIndexes.length > 0 ? newLearningIndexes : otherNonDueIndexes;
  const slots = Math.floor(remaining / questionCost);
  const floor = Math.min(
    slots,
    Math.max(nonDueQuestionFloor(slots, preferred.length), options?.reserveQuestionSlots ?? 0),
  );
  let protectedRemaining = Math.min(floor * questionCost, remaining);
  let flexible = remaining - protectedRemaining;

  for (const index of preferred) {
    if (protectedRemaining < questionCost) break;
    selectedIndexes.add(index);
    protectedRemaining -= questionCost;
  }

  let deferredDueCount = 0;
  for (const [index, item] of items.entries()) {
    if (item.source !== 'decay' || selectedIndexes.has(index)) continue;
    const cost = estimateStreamItemMinutes(item.item_kind, questionMinutes);
    if (cost <= flexible) {
      selectedIndexes.add(index);
      flexible -= cost;
    } else {
      deferredDueCount++;
    }
  }

  let leftover = flexible + protectedRemaining;
  for (const [index, item] of items.entries()) {
    if (selectedIndexes.has(index) || item.source === 'decay' || item.source === 'intervention') {
      continue;
    }
    const cost = estimateStreamItemMinutes(item.item_kind, questionMinutes);
    if (cost <= leftover) {
      selectedIndexes.add(index);
      leftover -= cost;
    }
  }

  const kept = items.filter((_, index) => selectedIndexes.has(index));
  return {
    kept,
    estimatedMinutes: kept.reduce(
      (sum, item) => sum + estimateStreamItemMinutes(item.item_kind, questionMinutes),
      0,
    ),
    deferredDueCount,
    truncated: kept.length < items.length,
  };
}

/**
 * Item-count cap. Drop the tail of the due segment first (least forgettable when that
 * segment is retrievability-ascending) so a reserved new-learning item is not the one cut.
 * Interventions stay. If nothing else can be dropped, the result may exceed `max`.
 */
export function capStreamToItemMax<T extends { source: string }>(
  items: readonly T[],
  max: number,
): { kept: T[]; truncated: boolean } {
  if (items.length <= max) return { kept: [...items], truncated: false };
  const dropIndexes = new Set<number>();
  const decayIndexes = items.flatMap((item, index) => (item.source === 'decay' ? [index] : []));
  for (const index of decayIndexes.slice(-(items.length - max))) dropIndexes.add(index);
  for (let index = items.length - 1; index >= 0 && dropIndexes.size < items.length - max; index--) {
    const source = items[index]?.source;
    if (source === 'intervention' || isNewLearningSource(source ?? '') || dropIndexes.has(index)) {
      continue;
    }
    dropIndexes.add(index);
  }
  return {
    kept: items.filter((_, index) => !dropIndexes.has(index)),
    truncated: true,
  };
}
