// YUK-673 — ADR-0042 L3 learning-mix guard.
//
// This module is intentionally pure: it receives an already assembled StreamPlan plus the
// stable question identities needed for repetition checks, then returns a repaired plan and
// structured degradation diagnostics. It never reads the DB, changes membership, or touches
// sampling probabilities.

import type { ComposerInputs, StreamPlan, StreamPlanItem } from './stream-composer';

export const FATIGUE_REPETITION_LIMIT = 2;

export interface RepetitionIdentity {
  knowledgeId?: string;
  questionKind?: string;
}

export interface LearningMixContext {
  frontierCandidateCount: number;
  frontierSelectedCount: number;
  repetitionByRef: ReadonlyMap<string, RepetitionIdentity>;
}

export type LearningMixDiagnostic =
  | {
      kind: 'anti_comfort_floor_unmet';
      frontierCandidateCount: number;
      reason: 'no_candidate' | 'not_selected' | 'budget_truncated';
    }
  | {
      kind: 'fatigue_repetition_unresolved';
      refId: string;
      dimensions: Array<'knowledge' | 'question_kind'>;
      limit: number;
    };

interface RunState {
  knowledgeId?: string;
  knowledgeCount: number;
  questionKind?: string;
  questionKindCount: number;
}

const EMPTY_RUN_STATE: RunState = {
  knowledgeCount: 0,
  questionKindCount: 0,
};

export function learningMixContextFromInputs(
  inputs: ComposerInputs,
  frontierSelectedCount = inputs.frontierItems?.length ?? 0,
): LearningMixContext {
  const repetitionByRef = new Map<string, RepetitionIdentity>();
  const add = (item: {
    questionId: string;
    knowledgeId?: string;
    questionKind?: string;
  }) => {
    // Composer membership is first-wins in this same source order. Keep the identity attached
    // to the retained item instead of letting a later duplicate source overwrite it.
    if (repetitionByRef.has(item.questionId)) return;
    repetitionByRef.set(item.questionId, {
      knowledgeId: item.knowledgeId,
      questionKind: item.questionKind,
    });
  };

  for (const item of inputs.dueItems) add(item);
  for (const item of inputs.variantItems) add(item);
  for (const item of inputs.newCheckItems) add(item);
  for (const item of inputs.frontierItems ?? []) add(item);

  return {
    frontierCandidateCount: inputs.frontierItems?.length ?? 0,
    frontierSelectedCount,
    repetitionByRef,
  };
}

function nextCount(currentValue: string | undefined, currentCount: number, next?: string): number {
  if (next === undefined) return 0;
  return currentValue === next ? currentCount + 1 : 1;
}

function antiComfortReason(
  context: LearningMixContext,
): 'no_candidate' | 'not_selected' | 'budget_truncated' {
  if (context.frontierCandidateCount === 0) return 'no_candidate';
  if (context.frontierSelectedCount === 0) return 'not_selected';
  return 'budget_truncated';
}

function violationsFor(
  item: StreamPlanItem,
  state: RunState,
  identities: ReadonlyMap<string, RepetitionIdentity>,
): Array<'knowledge' | 'question_kind'> {
  if (item.item_kind !== 'question') return [];
  const identity = identities.get(item.ref_id);
  const violations: Array<'knowledge' | 'question_kind'> = [];
  if (
    nextCount(state.knowledgeId, state.knowledgeCount, identity?.knowledgeId) >
    FATIGUE_REPETITION_LIMIT
  ) {
    violations.push('knowledge');
  }
  if (
    nextCount(state.questionKind, state.questionKindCount, identity?.questionKind) >
    FATIGUE_REPETITION_LIMIT
  ) {
    violations.push('question_kind');
  }
  return violations;
}

function advanceRunState(
  item: StreamPlanItem,
  state: RunState,
  identities: ReadonlyMap<string, RepetitionIdentity>,
): RunState {
  if (item.item_kind !== 'question') return EMPTY_RUN_STATE;
  const identity = identities.get(item.ref_id);
  return {
    knowledgeId: identity?.knowledgeId,
    knowledgeCount: nextCount(state.knowledgeId, state.knowledgeCount, identity?.knowledgeId),
    questionKind: identity?.questionKind,
    questionKindCount: nextCount(
      state.questionKind,
      state.questionKindCount,
      identity?.questionKind,
    ),
  };
}

function dimensionRemainsFeasible(
  remaining: StreamPlanItem[],
  currentValue: string | undefined,
  currentCount: number,
  identities: ReadonlyMap<string, RepetitionIdentity>,
  dimension: keyof RepetitionIdentity,
): boolean {
  const values = remaining.map((item) =>
    item.item_kind === 'question' ? identities.get(item.ref_id)?.[dimension] : undefined,
  );
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  for (const [value, count] of counts) {
    const separators = values.length - count;
    const initialCapacity =
      currentValue === value ? FATIGUE_REPETITION_LIMIT - currentCount : FATIGUE_REPETITION_LIMIT;
    const capacity = initialCapacity + separators * FATIGUE_REPETITION_LIMIT;
    if (count > capacity) return false;
  }
  return true;
}

function remainingMixIsFeasibleAfter(
  selectedIndex: number,
  remaining: StreamPlanItem[],
  state: RunState,
  identities: ReadonlyMap<string, RepetitionIdentity>,
): boolean {
  const nextState = advanceRunState(remaining[selectedIndex], state, identities);
  const rest = remaining.filter((_, index) => index !== selectedIndex);
  return (
    dimensionRemainsFeasible(
      rest,
      nextState.knowledgeId,
      nextState.knowledgeCount,
      identities,
      'knowledgeId',
    ) &&
    dimensionRemainsFeasible(
      rest,
      nextState.questionKind,
      nextState.questionKindCount,
      identities,
      'questionKind',
    )
  );
}

function reorderQuestionSegment(
  segment: StreamPlanItem[],
  identities: ReadonlyMap<string, RepetitionIdentity>,
): { items: StreamPlanItem[]; diagnostics: LearningMixDiagnostic[] } {
  const remaining = [...segment];
  const items: StreamPlanItem[] = [];
  const diagnostics: LearningMixDiagnostic[] = [];
  let state = EMPTY_RUN_STATE;

  while (remaining.length > 0) {
    const keepDueWarmupFirst = items.length === 0 && remaining[0]?.source === 'decay';
    const firstDueIndex = remaining.findIndex((item) => item.source === 'decay');
    const eligibleIndices = remaining
      .map((item, index) => ({ item, index }))
      // Later due items may not overtake the earliest remaining due item. Non-due items may be
      // interleaved around it, preserving the complete due subsequence exactly. The opening due
      // item remains locked first so the composer's due-warmup invariant survives this repair.
      .filter(
        ({ item, index }) =>
          (!keepDueWarmupFirst || index === 0) &&
          (item.source !== 'decay' || index === firstDueIndex),
      )
      .map(({ index }) => index);
    const safeIndices = eligibleIndices.filter(
      (index) => violationsFor(remaining[index], state, identities).length === 0,
    );
    // Prefer the earliest safe item whose removal leaves enough separators for every remaining
    // KC and question kind. This prevents consuming the only break too early (A,B,B,B), while
    // retaining stable order whenever the suffix is still schedulable.
    const feasibleIndex = safeIndices.find((index) =>
      remainingMixIsFeasibleAfter(index, remaining, state, identities),
    );
    const selectedIndex = feasibleIndex ?? safeIndices[0] ?? eligibleIndices[0] ?? 0;
    const [selected] = remaining.splice(selectedIndex, 1);
    const violations = violationsFor(selected, state, identities);
    if (violations.length > 0) {
      diagnostics.push({
        kind: 'fatigue_repetition_unresolved',
        refId: selected.ref_id,
        dimensions: violations,
        limit: FATIGUE_REPETITION_LIMIT,
      });
    }
    items.push(selected);
    state = advanceRunState(selected, state, identities);
  }

  return { items, diagnostics };
}

function reorderForFatigue(
  items: StreamPlanItem[],
  identities: ReadonlyMap<string, RepetitionIdentity>,
): { items: StreamPlanItem[]; diagnostics: LearningMixDiagnostic[] } {
  const reordered: StreamPlanItem[] = [];
  const diagnostics: LearningMixDiagnostic[] = [];
  let segment: StreamPlanItem[] = [];

  const flush = () => {
    if (segment.length === 0) return;
    const result = reorderQuestionSegment(segment, identities);
    reordered.push(...result.items);
    diagnostics.push(...result.diagnostics);
    segment = [];
  };

  for (const item of items) {
    if (item.item_kind === 'paper') {
      flush();
      reordered.push(item);
      continue;
    }
    segment.push(item);
  }
  flush();

  return { items: reordered, diagnostics };
}

/**
 * Apply the thin ADR-0042 L3 learning-mix guard.
 *
 * - fatigue/repetition: stable-reorder questions to avoid >2 consecutive items with the same
 *   primary KC or question kind. Papers delimit runs. Membership and due relative order stay
 *   unchanged; if no legal alternative exists, retain the item and emit a diagnostic.
 * - anti-comfort floor: current supply has no deterministic transfer source, so a missing
 *   frontier is surfaced as a structured degradation signal rather than silently inventing or
 *   force-selecting a question. YUK-361 Phase 3 owns the future transfer fallback.
 */
export function applyL3LearningMixGuard(plan: StreamPlan, context: LearningMixContext): StreamPlan {
  if (plan.items.length === 0) return plan;

  const reordered = reorderForFatigue(plan.items, context.repetitionByRef);
  const diagnostics: LearningMixDiagnostic[] = [
    ...(plan.diagnostics ?? []),
    ...reordered.diagnostics,
  ];
  const hasQuestion = reordered.items.some((item) => item.item_kind === 'question');
  const hasFrontier = reordered.items.some((item) => item.source === 'frontier');
  if (hasQuestion && !hasFrontier) {
    diagnostics.push({
      kind: 'anti_comfort_floor_unmet',
      frontierCandidateCount: context.frontierCandidateCount,
      reason: antiComfortReason(context),
    });
  }

  return {
    ...plan,
    items: reordered.items.map((item, index) => ({ ...item, position: index + 1 })),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
