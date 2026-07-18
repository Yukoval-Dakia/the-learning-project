import { describe, expect, it } from 'vitest';
import {
  FATIGUE_REPETITION_LIMIT,
  type LearningMixContext,
  applyL3LearningMixGuard,
  learningMixContextFromInputs,
} from './post-filter';
import type { StreamPlan, StreamPlanItem } from './stream-composer';

function question(refId: string, source: StreamPlanItem['source'] = 'variant'): StreamPlanItem {
  return {
    position: 0,
    item_kind: 'question',
    ref_id: refId,
    source,
    reasoning: refId,
  };
}

function plan(items: StreamPlanItem[], truncated = false): StreamPlan {
  return {
    date: '2026-07-18',
    items: items.map((item, index) => ({ ...item, position: index + 1 })),
    truncated,
    warned: false,
  };
}

function context(
  identities: Record<string, { knowledgeId?: string; questionKind?: string }>,
  frontierCandidateCount = 0,
  frontierSelectedCount = frontierCandidateCount,
): LearningMixContext {
  return {
    frontierCandidateCount,
    frontierSelectedCount,
    repetitionByRef: new Map(Object.entries(identities)),
  };
}

describe('ADR-0042 L3 learning-mix guard (YUK-673)', () => {
  it('emits a structured anti-comfort degradation when an all-comfortable stream has no frontier supply', () => {
    const result = applyL3LearningMixGuard(plan([question('q1'), question('q2')]), context({}));

    expect(result.diagnostics).toContainEqual({
      kind: 'anti_comfort_floor_unmet',
      frontierCandidateCount: 0,
      reason: 'no_candidate',
    });
  });

  it('distinguishes a supplied frontier candidate that was trimmed by the daily budget', () => {
    const result = applyL3LearningMixGuard(plan([question('q1')], true), context({}, 1));

    expect(result.diagnostics).toContainEqual({
      kind: 'anti_comfort_floor_unmet',
      frontierCandidateCount: 1,
      reason: 'budget_truncated',
    });
  });

  it('distinguishes a frontier candidate that the sampler did not select', () => {
    const result = applyL3LearningMixGuard(plan([question('q1')]), context({}, 1, 0));

    expect(result.diagnostics).toContainEqual({
      kind: 'anti_comfort_floor_unmet',
      frontierCandidateCount: 1,
      reason: 'not_selected',
    });
  });

  it('stable-reorders an alternative before a third consecutive KC and question kind', () => {
    const result = applyL3LearningMixGuard(
      plan([question('q1'), question('q2'), question('q3'), question('q4')]),
      context({
        q1: { knowledgeId: 'kc-a', questionKind: 'choice' },
        q2: { knowledgeId: 'kc-a', questionKind: 'choice' },
        q3: { knowledgeId: 'kc-a', questionKind: 'choice' },
        q4: { knowledgeId: 'kc-b', questionKind: 'short_answer' },
      }),
    );

    expect(result.items.map((item) => item.ref_id)).toEqual(['q1', 'q2', 'q4', 'q3']);
    expect(result.items.map((item) => item.position)).toEqual([1, 2, 3, 4]);
    expect(
      result.diagnostics?.filter((item) => item.kind === 'fatigue_repetition_unresolved'),
    ).toEqual([]);
  });

  it('preserves first-wins identity when the same question appears in multiple sources', () => {
    const mixContext = learningMixContextFromInputs({
      date: '2026-07-18',
      dueItems: [{ questionId: 'q1', knowledgeId: 'due-kc', questionKind: 'choice' }],
      variantItems: [
        {
          questionId: 'q1',
          rootQuestionId: 'root-q1',
          knowledgeId: 'discarded-kc',
          questionKind: 'short_answer',
        },
      ],
      newCheckItems: [],
      frontierItems: [],
      pendingPapers: [],
    });

    expect(mixContext.repetitionByRef.get('q1')).toEqual({
      knowledgeId: 'due-kc',
      questionKind: 'choice',
    });
  });

  it('does not consume the only fatigue break before a repeated suffix', () => {
    const result = applyL3LearningMixGuard(
      plan([question('a'), question('b1'), question('b2'), question('b3')]),
      context({
        a: { knowledgeId: 'kc-a', questionKind: 'short_answer' },
        b1: { knowledgeId: 'kc-b', questionKind: 'choice' },
        b2: { knowledgeId: 'kc-b', questionKind: 'choice' },
        b3: { knowledgeId: 'kc-b', questionKind: 'choice' },
      }),
    );

    expect(result.items.map((item) => item.ref_id)).toEqual(['b1', 'a', 'b2', 'b3']);
    expect(
      result.diagnostics?.filter((item) => item.kind === 'fatigue_repetition_unresolved'),
    ).toEqual([]);
  });

  it('keeps the due warmup first even when moving it would be the only fatigue repair', () => {
    const result = applyL3LearningMixGuard(
      plan([question('due', 'decay'), question('b1'), question('b2'), question('b3')]),
      context({
        due: { knowledgeId: 'kc-a' },
        b1: { knowledgeId: 'kc-b' },
        b2: { knowledgeId: 'kc-b' },
        b3: { knowledgeId: 'kc-b' },
      }),
    );

    expect(result.items[0].ref_id).toBe('due');
    expect(result.items[0].source).toBe('decay');
    expect(result.diagnostics).toContainEqual({
      kind: 'fatigue_repetition_unresolved',
      refId: 'b3',
      dimensions: ['knowledge'],
      limit: FATIGUE_REPETITION_LIMIT,
    });
  });

  it('treats an empty identity as a real repetition value instead of missing metadata', () => {
    const result = applyL3LearningMixGuard(
      plan([question('q1'), question('q2'), question('q3'), question('break')]),
      context({
        q1: { knowledgeId: '' },
        q2: { knowledgeId: '' },
        q3: { knowledgeId: '' },
        break: { knowledgeId: 'kc-b' },
      }),
    );

    expect(result.items.map((item) => item.ref_id)).toEqual(['q1', 'q2', 'break', 'q3']);
  });

  it('preserves the due subsequence while interleaving a non-due fatigue break', () => {
    const result = applyL3LearningMixGuard(
      plan([
        question('due-1', 'decay'),
        question('due-2', 'decay'),
        question('due-3', 'decay'),
        question('break'),
      ]),
      context({
        'due-1': { knowledgeId: 'kc-a' },
        'due-2': { knowledgeId: 'kc-a' },
        'due-3': { knowledgeId: 'kc-a' },
        break: { knowledgeId: 'kc-b' },
      }),
    );

    expect(result.items.map((item) => item.ref_id)).toEqual(['due-1', 'due-2', 'break', 'due-3']);
    expect(
      result.items.filter((item) => item.source === 'decay').map((item) => item.ref_id),
    ).toEqual(['due-1', 'due-2', 'due-3']);
  });

  it('retains the item and emits a fatigue diagnostic when no legal alternative exists', () => {
    const result = applyL3LearningMixGuard(
      plan([question('q1'), question('q2'), question('q3')]),
      context({
        q1: { knowledgeId: 'kc-a', questionKind: 'choice' },
        q2: { knowledgeId: 'kc-a', questionKind: 'choice' },
        q3: { knowledgeId: 'kc-a', questionKind: 'choice' },
      }),
    );

    expect(result.items.map((item) => item.ref_id)).toEqual(['q1', 'q2', 'q3']);
    expect(result.diagnostics).toContainEqual({
      kind: 'fatigue_repetition_unresolved',
      refId: 'q3',
      dimensions: ['knowledge', 'question_kind'],
      limit: FATIGUE_REPETITION_LIMIT,
    });
  });
});
