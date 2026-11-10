import { estimateStreamItemMinutes, nonDueQuestionFloor } from './stream-budget';

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
  /** Preference order for the deterministic non-due floor. Omitted → no floor. */
  floorCandidateRefIds?: readonly string[];
}

/** New-learning refs first; variants only when no new-learning candidate survives the due set. */
export function nonDueFloorCandidateIds(
  inputs: {
    variantItems: readonly { questionId: string }[];
    newCheckItems: readonly { questionId: string }[];
    frontierItems?: readonly { questionId: string }[];
  },
  dueIds: ReadonlySet<string>,
): string[] {
  const fresh = (ids: readonly string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (dueIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  const learning = fresh([
    ...inputs.newCheckItems.map((item) => item.questionId),
    ...(inputs.frontierItems ?? []).map((item) => item.questionId),
  ]);
  if (learning.length > 0) return learning;
  return fresh(inputs.variantItems.map((item) => item.questionId));
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
  floorCandidateRefIds,
}: NonDueSelectionInputs<Signal>): {
  recallLocked: Signal[];
  recallLockedRefs: Set<string>;
  samplable: Signal[];
  floorPassthrough: Signal[];
  effectiveTarget: number;
} {
  const allRecallLocked = signals.filter(
    (s) => s.refKind === 'question' && s.recallLocked === true,
  );
  const allRecallLockedRefs = new Set(allRecallLocked.map((s) => s.refId));
  const samplablePool = signals.filter(
    (s) => s.refKind === 'question' && !allRecallLockedRefs.has(s.refId),
  );
  const floorPassthrough = selectNonDueFloor(samplablePool, floorCandidateRefIds, {
    dailyBudgetMinutes,
    questionMinutes,
  });
  const questionCost = estimateStreamItemMinutes('question', questionMinutes);
  const dueMinutes = dueDrafts.reduce(
    (sum, item) => sum + estimateStreamItemMinutes(item.item_kind, questionMinutes),
    0,
  );
  const floorMinutes = floorPassthrough.length * questionCost;
  const remainingAfterDue =
    dailyBudgetMinutes === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, dailyBudgetMinutes - dueMinutes - floorMinutes);
  const recallLimit = Number.isFinite(remainingAfterDue)
    ? Math.floor(remainingAfterDue / questionCost)
    : allRecallLocked.length;
  const recallLocked = allRecallLocked.slice(0, recallLimit);
  const recallLockedRefs = new Set(recallLocked.map((s) => s.refId));
  const floorIds = new Set(floorPassthrough.map((signal) => signal.refId));
  const samplable = samplablePool.filter((signal) => !floorIds.has(signal.refId));

  // Due, selected recall, and the deterministic non-due floor reserve capacity before
  // sampling. Papers are a truncatable tail after sampled questions, so they do not
  // reserve sampler capacity.
  const fixedCount = dueDrafts.length + recallLocked.length + floorPassthrough.length;
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

  return { recallLocked, recallLockedRefs, samplable, floorPassthrough, effectiveTarget };
}

function selectNonDueFloor<Signal extends NonDueSelectionSignal>(
  samplable: readonly Signal[],
  floorCandidateRefIds: readonly string[] | undefined,
  budget: { dailyBudgetMinutes: number | undefined; questionMinutes: number | undefined },
): Signal[] {
  if (budget.dailyBudgetMinutes === undefined || !floorCandidateRefIds?.length) return [];
  const byId = new Map(samplable.map((signal) => [signal.refId, signal]));
  const eligible = floorCandidateRefIds.filter((id) => byId.has(id));
  const questionSlots = Math.floor(
    budget.dailyBudgetMinutes / estimateStreamItemMinutes('question', budget.questionMinutes),
  );
  const floor = nonDueQuestionFloor(questionSlots, eligible.length);
  const picked: Signal[] = [];
  for (const id of eligible) {
    if (picked.length >= floor) break;
    const signal = byId.get(id);
    if (signal) picked.push(signal);
  }
  return picked;
}
