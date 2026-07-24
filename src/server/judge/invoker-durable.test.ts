// YUK-594 (D7/D9) — the invoker's durable-run override. When invoke() is called with
// `durable`, the runner ctx that reaches runTask must (D7) FORCE enableTransientRetry
// OFF — even on the steps/multimodal routes that opt IN by default (YUK-576) — because
// queue re-delivery is the durable handler's only transient layer; and (D9) when a
// providerOverride is present, it must be merged into ctx.override.provider so the
// fallback re-delivery crosses lanes via the existing resolveTaskProvider seam.
//
// The '@/server/ai/runner' module is mocked so runTask is a spy we assert the ctx on;
// the steps route dispatches through the invoker's judgeDefaultRunTaskFn → runTask, so
// the spy sees exactly the ctx the runner would receive.

import type { Db } from '@/db/client';
import type { JudgeQuestionRow } from '@/server/ai/judges/question-contract';
import { resolveSubjectProfile } from '@/subjects/profile';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runTaskSpy } = vi.hoisted(() => ({ runTaskSpy: vi.fn() }));

vi.mock('@/server/ai/runner', () => ({
  runTask: runTaskSpy,
}));

import { JudgeInvoker } from './invoker';

const mockDb = {} as Db;
const mathProfile = resolveSubjectProfile('math');

const stepsQuestion: JudgeQuestionRow = {
  id: 'q-steps-durable',
  kind: 'derivation',
  prompt_md: '题目',
  reference_md: '答案',
  rubric_json: {
    criteria: [{ name: 'correctness', weight: 1, descriptor: 'steps' }],
    reference_solution: {
      expected_signals: ['列出 x=1'],
      final_answer: '1',
      answer_equivalents: [],
    },
  },
  choices_md: null,
  judge_kind_override: null,
};

function stepsResult() {
  return {
    task_run_id: 'tr-steps',
    text: JSON.stringify({
      extracted_steps: [{ idx: 0, content: 'x=1', verdict: 'correct', comment: 'ok' }],
      extracted_final_answer: '1',
      signal_verdicts: [{ signal_idx: 0, verdict: 'correct', comment: 'ok' }],
      final_answer_match: true,
      final_answer_comment: '推导正确。',
      confidence: 0.88,
    }),
  };
}

describe('JudgeInvoker durable override (YUK-594 D7/D9)', () => {
  beforeEach(() => {
    runTaskSpy.mockReset();
    vi.stubEnv('VISION_JUDGE_PROVIDER', 'xiaomi');
  });

  it('D7: durable:{} FORCES enableTransientRetry OFF even on the steps opt-in route', async () => {
    runTaskSpy.mockResolvedValue(stepsResult());
    const result = await new JudgeInvoker().invoke({
      db: mockDb,
      question: stepsQuestion,
      answer_md: 'x=1，所以答案是 1',
      subjectProfile: mathProfile,
      durable: {},
    });
    expect(result.route).toBe('steps');
    const ctx = runTaskSpy.mock.calls[0]?.[2] as { enableTransientRetry?: boolean };
    expect(ctx.enableTransientRetry).toBe(false);
  });

  it('D9: durable.providerOverride is merged into ctx.override.provider (+ transient OFF)', async () => {
    runTaskSpy.mockResolvedValue(stepsResult());
    const result = await new JudgeInvoker().invoke({
      db: mockDb,
      question: stepsQuestion,
      answer_md: 'x=1，所以答案是 1',
      subjectProfile: mathProfile,
      durable: { providerOverride: 'anthropic-sub' },
    });
    expect(result.route).toBe('steps');
    const ctx = runTaskSpy.mock.calls[0]?.[2] as {
      enableTransientRetry?: boolean;
      override?: { provider?: string };
    };
    expect(ctx.enableTransientRetry).toBe(false);
    expect(ctx.override?.provider).toBe('anthropic-sub');
  });

  it('no durable → the sync path keeps the steps opt-in (enableTransientRetry:true, no forced override)', async () => {
    runTaskSpy.mockResolvedValue(stepsResult());
    await new JudgeInvoker().invoke({
      db: mockDb,
      question: stepsQuestion,
      answer_md: 'x=1，所以答案是 1',
      subjectProfile: mathProfile,
    });
    const ctx = runTaskSpy.mock.calls[0]?.[2] as {
      enableTransientRetry?: boolean;
      override?: { provider?: string };
    };
    expect(ctx.enableTransientRetry).toBe(true);
    // The sync path is NOT forced onto the fallback lane (the vision judge keeps its
    // own provider selection; durable's forced anthropic-sub override never applies).
    expect(ctx.override?.provider).not.toBe('anthropic-sub');
  });
});
