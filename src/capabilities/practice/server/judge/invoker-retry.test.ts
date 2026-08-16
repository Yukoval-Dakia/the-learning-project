// YUK-589 (K2) — the invoker's DEFAULT judge task runner must preserve the
// sanctioned `enableTransientRetry` opt-in the vision judges set (steps /
// multimodal_direct, YUK-576) all the way through to runTask.
//
// The regression: once invoke() began wrapping every runner in observedRunTaskFn,
// the DEFAULT (non-injected) path routed steps/multimodal through the shared
// makeRunTaskTextFn (defaultRunTaskFn), which STRIPS enableTransientRetry at the
// untrusted-caller boundary — silently disabling transient retry. These tests pin
// that the opt-in flag reaches runTask on the default path (no injected runTaskFn).
//
// The full '@/server/ai/runner' module is mocked so runTask is a spy we can assert
// the ctx on; both routes here dispatch through the invoker's judgeDefaultRunTaskFn
// → runTask, so the spy sees exactly the ctx the runner would receive.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeQuestionRow } from '@/capabilities/practice/server/judge/question-contract';
import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';

const { runTaskSpy } = vi.hoisted(() => ({ runTaskSpy: vi.fn() }));

vi.mock('@/server/ai/runner', () => ({
  runTask: runTaskSpy,
}));

import { JudgeInvoker } from './invoker';

const mockDb = {} as Db;
const mathProfile = resolveSubjectProfile('math');
const physicsProfile = resolveSubjectProfile('physics');

const baseQuestion: JudgeQuestionRow = {
  id: 'q-base',
  kind: 'short_answer',
  prompt_md: '题目',
  reference_md: '答案',
  rubric_json: null,
  choices_md: null,
  judge_kind_override: null,
};

describe('JudgeInvoker default-path enableTransientRetry (YUK-589 K2)', () => {
  beforeEach(() => {
    runTaskSpy.mockReset();
  });

  it('threads enableTransientRetry:true to runTask on the steps default path', async () => {
    vi.stubEnv('VISION_JUDGE_PROVIDER', 'xiaomi');
    runTaskSpy.mockResolvedValue({
      task_run_id: 'tr-steps',
      text: JSON.stringify({
        extracted_steps: [{ idx: 0, content: 'x=1', verdict: 'correct', comment: 'ok' }],
        extracted_final_answer: '1',
        signal_verdicts: [{ signal_idx: 0, verdict: 'correct', comment: 'ok' }],
        final_answer_match: true,
        final_answer_comment: '推导正确。',
        confidence: 0.88,
      }),
    });

    // NOTE: no injected runTaskFn — this exercises the invoker's default runner.
    const result = await new JudgeInvoker().invoke({
      db: mockDb,
      question: {
        ...baseQuestion,
        id: 'q-steps-default',
        kind: 'derivation',
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: 'steps' }],
          reference_solution: {
            expected_signals: ['列出 x=1'],
            final_answer: '1',
            answer_equivalents: [],
          },
        },
      },
      answer_md: 'x=1，所以答案是 1',
      subjectProfile: mathProfile,
    });

    expect(result.route).toBe('steps');
    expect(runTaskSpy).toHaveBeenCalledWith(
      'StepsJudgeTask',
      expect.objectContaining({ images: [] }),
      expect.objectContaining({ enableTransientRetry: true }),
    );
  });

  it('threads enableTransientRetry:true to runTask on the multimodal_direct default path', async () => {
    vi.stubEnv('VISION_JUDGE_PROVIDER', 'xiaomi');
    runTaskSpy.mockResolvedValue({
      task_run_id: 'tr-mm',
      text: JSON.stringify({
        coarse_outcome: 'correct',
        score: 0.9,
        feedback_md: '看图作答正确。',
        evidence: {
          observed_md: '图中受力分析完整。',
          matched_points: ['受力图'],
          missing_points: [],
        },
        confidence: 0.86,
      }),
    });

    const result = await new JudgeInvoker().invoke({
      db: mockDb,
      question: {
        ...baseQuestion,
        id: 'q-mm-default',
        kind: 'short_answer',
        prompt_md: '看图描述受力',
        reference_md: null,
        judge_kind_override: 'multimodal_direct',
      },
      answer_md: '受力如图所示，合力向右。',
      subjectProfile: physicsProfile,
    });

    expect(result.route).toBe('multimodal_direct');
    expect(runTaskSpy).toHaveBeenCalledWith(
      'MultimodalDirectJudgeTask',
      expect.objectContaining({ images: [] }),
      expect.objectContaining({ enableTransientRetry: true }),
    );
  });
});
