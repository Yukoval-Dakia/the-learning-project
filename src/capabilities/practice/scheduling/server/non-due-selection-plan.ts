import { estimateStreamItemMinutes } from './stream-budget';

interface NonDueSelectionSignal {
  refKind: 'question' | 'paper';
  refId: string;
  recallLocked?: boolean;
}

interface NonDueSelectionInputs<Signal extends NonDueSelectionSignal> {
  signals: readonly Signal[];
  dueDrafts: readonly { item_kind: 'question' | 'paper' }[];
  max: number;
  dailyBudgetMinutes: number | undefined;
  questionMinutes: number | undefined;
  targetCount: number | undefined;
}

/**
 * Decide deterministic recall passthrough, the eligible sampling pool, and its target.
 * Preserve collection order, duplicates, and complete signal objects without mutating inputs.
 * Every recall-locked ref stays out of sampling, including recall items that do not fit today.
 * Numeric inputs retain their existing arithmetic semantics without normalization.
 */
export function planNonDueSelection<Signal extends NonDueSelectionSignal>({
  signals,
  dueDrafts,
  max,
  dailyBudgetMinutes,
  questionMinutes,
  targetCount,
}: NonDueSelectionInputs<Signal>): {
  recallLocked: Signal[];
  recallLockedRefs: Set<string>;
  samplable: Signal[];
  effectiveTarget: number;
} {
  const allRecallLocked = signals.filter(
    (s) => s.refKind === 'question' && s.recallLocked === true,
  );
  const dueMinutes = dueDrafts.reduce(
    (sum, item) => sum + estimateStreamItemMinutes(item.item_kind, questionMinutes),
    0,
  );
  const remainingAfterDue =
    dailyBudgetMinutes === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, dailyBudgetMinutes - dueMinutes);
  const recallLimit = Number.isFinite(remainingAfterDue)
    ? Math.floor(remainingAfterDue / estimateStreamItemMinutes('question', questionMinutes))
    : allRecallLocked.length;
  const recallLocked = allRecallLocked.slice(0, recallLimit);
  const recallLockedRefs = new Set(recallLocked.map((s) => s.refId));
  const allRecallLockedRefs = new Set(allRecallLocked.map((s) => s.refId));
  const samplable = signals.filter(
    (s) => s.refKind === 'question' && !allRecallLockedRefs.has(s.refId),
  );

  // Due and selected recall items reserve capacity before sampling. Papers are a
  // truncatable tail after sampled questions, so they do not reserve sampler capacity.
  const fixedCount = dueDrafts.length + recallLocked.length;
  const nonDueBudget = Math.max(0, max - fixedCount);
  const fixedMinutes = fixedCount * estimateStreamItemMinutes('question', questionMinutes);
  const timeQuestionBudget =
    dailyBudgetMinutes === undefined
      ? nonDueBudget
      : Math.max(
          0,
          Math.floor(
            (dailyBudgetMinutes - fixedMinutes) /
              estimateStreamItemMinutes('question', questionMinutes),
          ),
        );

  // The experiment target can lower the capacity/time bound; omission keeps that bound.
  const boundedNonDueBudget = Math.min(nonDueBudget, timeQuestionBudget);
  const effectiveTarget =
    targetCount !== undefined ? Math.min(targetCount, boundedNonDueBudget) : boundedNonDueBudget;

  return { recallLocked, recallLockedRefs, samplable, effectiveTarget };
}
