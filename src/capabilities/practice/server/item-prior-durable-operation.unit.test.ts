// Offline retained-consumer checks. Provider and persistence are stubbed; numeric
// parsing/aggregation and the retained handler's operation are real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runItemPriorBackfill } from '@/capabilities/practice/jobs/item_prior_backfill';
import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import type { ItemPriorCandidateFrozen } from './item-prior-durable-operation';
import type { PracticeTaskRunFn } from './task-runtime';

vi.mock('@/server/mastery/item-calibration', () => ({ applyItemPrior: vi.fn() }));
vi.mock('./knowledge-runtime', () => ({
  resolveSubjectProfileForKnowledgeIds: async () => undefined,
}));

function candidate(id: string): ItemPriorCandidateFrozen {
  return {
    id,
    kind: 'short_answer',
    prompt_md: '比较两种解法的条件与结论。\n'.repeat(40),
    reference_md: '先分类讨论，再检查边界条件。',
    choices_md: null,
    knowledge_ids: ['kc_boundary', 'kc_unknown'],
  };
}

function database(candidates: ItemPriorCandidateFrozen[]): Db {
  // Test-only Drizzle read-chain double; no real connection or global client.
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === question)
            return { limit: async (limit: number) => candidates.slice(0, limit) };
          if (table === knowledge)
            return Promise.resolve([{ id: 'kc_boundary', name: '边界条件' }]);
          throw new Error('Unexpected table');
        },
      }),
    }),
  } as unknown as Db;
}

function text(b: number, confidence: number) {
  return JSON.stringify({ b_logit: b, confidence, reasoning: '嵌套分类讨论与边界检查' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('retained item_prior_backfill consumer', () => {
  // @invariant grading: the retained default settles the median of three prior estimates
  // @fails-if default reps becomes one or aggregation uses the mean; persisted b/confidence differ
  it('passes the default three-rep median to the calibration writer', async () => {
    const outputs = [text(5.3, 0.9), text(0.1, 0.2), text(0.7, 0.4)];
    const runTaskFn: PracticeTaskRunFn = async () => ({ text: outputs.shift() ?? '' });
    const result = await runItemPriorBackfill(database([candidate('q_median')]), { runTaskFn });
    expect(result).toEqual({ considered: 1, calibrated: 1, skipped_failed: 0 });
    expect(vi.mocked(applyItemPrior).mock.calls.map(([, input]) => input)).toEqual([
      {
        questionId: 'q_median',
        draft: {
          b_logit: 0.7,
          confidence: 0.4,
          reasoning: expect.any(String),
        },
        source: 'llm_prior',
      },
    ]);
  });

  // @invariant grading: failed reps cannot invent anchors or prevent settlement of a later valid item
  // @fails-if failed reps are defaulted into drafts or all-failed handling escapes the item catch
  it('settles only surviving drafts and leaves the all-failed item uncalibrated', async () => {
    const outputs = [
      '{broken json',
      text(-0.4, 0.2),
      text(0.8, 0.6),
      'no output',
      new Error('connection lost after dispatch; paid outcome unknown'),
      text(7, 0.5),
      text(1.2, 0.3),
      text(1.4, 0.5),
      text(1.6, 0.7),
    ];
    const runTaskFn: PracticeTaskRunFn = async () => {
      const output = outputs.shift();
      if (output instanceof Error) throw output;
      return { text: output ?? '' };
    };
    const result = await runItemPriorBackfill(
      database([candidate('q_partial'), candidate('q_failed'), candidate('q_later')]),
      { runTaskFn },
    );
    expect(result).toEqual({ considered: 3, calibrated: 2, skipped_failed: 1 });
    const writes = vi.mocked(applyItemPrior).mock.calls.map(([, input]) => input);
    expect(writes.map(({ questionId }) => questionId)).toEqual(['q_partial', 'q_later']);
    expect(writes[0]?.draft.b_logit).toBeCloseTo(0.2, 10);
    expect(writes[0]?.draft.confidence).toBeCloseTo(0.4, 10);
    expect(writes[1]?.draft.b_logit).toBe(1.4);
    expect(writes[1]?.draft.confidence).toBe(0.5);
  });
});
