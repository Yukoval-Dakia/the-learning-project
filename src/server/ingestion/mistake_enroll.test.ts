import { describe, expect, it, vi } from 'vitest';

import type { CauseProfileLike } from '@/core/schema/cause';
import type { MistakeEnrollInputT } from '@/core/schema/mistake_enroll';
import { MistakeEnrollTaskError, runMistakeEnrollTask } from './mistake_enroll';

// CauseProfileLike test double — three ids incl. the 'other' fallback.
const profile: CauseProfileLike = {
  causeCategories: [
    { id: 'careless', label: '粗心' },
    { id: 'concept', label: '概念' },
    { id: 'other', label: '其它' },
  ],
};

function stub(json: unknown) {
  return vi.fn(async (_kind: string, _input: MistakeEnrollInputT, _ctx: unknown) => ({
    text: JSON.stringify(json),
  }));
}

const FAILURE_JSON = {
  wrong_answer: 'failure',
  question_type: 'computation',
  difficulty: 3,
  cause: {
    primary_category: 'concept',
    secondary_categories: ['careless'],
    analysis_md: '把公式记错了',
    confidence: 0.8,
  },
  overall_confidence: 0.7,
  reasoning: 'final answer wrong',
};

describe('runMistakeEnrollTask', () => {
  it('drafts the full mistake metadata and passes the answer + allowed ids to the model', async () => {
    const runTaskFn = stub(FAILURE_JSON);
    const out = await runMistakeEnrollTask({
      questionMd: '化简 (a^2-b^2)/(a-b)',
      referenceMd: 'a+b',
      studentAnswerMd: 'a-b',
      knowledgeIds: ['k1'],
      profile,
      runTaskFn,
    });

    expect(out.wrong_answer).toBe('failure');
    expect(out.question_type).toBe('computation');
    expect(out.difficulty).toBe(3);
    expect(out.cause?.primary_category).toBe('concept');
    expect(out.overall_confidence).toBe(0.7);

    // The model saw the question, the student's answer, and the allowed taxonomy.
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const [kind, input] = runTaskFn.mock.calls[0];
    expect(kind).toBe('MistakeEnrollTask');
    expect(input.question_md).toContain('化简');
    expect(input.student_answer_md).toBe('a-b');
    expect(input.allowed_cause_ids).toEqual(['careless', 'concept', 'other']);
  });

  it('forces unanswered + null cause when the student answer is blank, ignoring the model', async () => {
    // Model wrongly claims a failure + cause; the invoker must override on blank.
    const runTaskFn = stub({ ...FAILURE_JSON });
    const out = await runMistakeEnrollTask({
      questionMd: 'q',
      studentAnswerMd: '   ',
      profile,
      runTaskFn,
    });
    expect(out.wrong_answer).toBe('unanswered');
    expect(out.cause).toBeNull();
  });

  it('keeps the cause only for a failure outcome', async () => {
    const runTaskFn = stub({ ...FAILURE_JSON, wrong_answer: 'success' });
    const out = await runMistakeEnrollTask({
      questionMd: 'q',
      studentAnswerMd: 'a+b',
      profile,
      runTaskFn,
    });
    expect(out.wrong_answer).toBe('success');
    expect(out.cause).toBeNull();
  });

  it('clamps an out-of-taxonomy cause to the profile fallback and drops bad secondaries', async () => {
    const runTaskFn = stub({
      ...FAILURE_JSON,
      cause: {
        primary_category: 'not_a_real_cause',
        secondary_categories: ['concept', 'also_fake'],
        analysis_md: 'x',
        confidence: 0.6,
      },
    });
    const out = await runMistakeEnrollTask({
      questionMd: 'q',
      studentAnswerMd: 'wrong',
      profile,
      runTaskFn,
    });
    expect(out.cause?.primary_category).toBe('other'); // clamped to fallback
    expect(out.cause?.secondary_categories).toEqual(['concept']); // 'also_fake' dropped
  });

  it('wraps a provider failure in MistakeEnrollTaskError', async () => {
    const runTaskFn = vi.fn(async () => {
      throw new Error('LLM down');
    });
    await expect(
      runMistakeEnrollTask({ questionMd: 'q', studentAnswerMd: 'a', profile, runTaskFn }),
    ).rejects.toBeInstanceOf(MistakeEnrollTaskError);
  });

  it('throws MistakeEnrollTaskError on unparseable output', async () => {
    const runTaskFn = vi.fn(async () => ({ text: 'not json at all' }));
    await expect(
      runMistakeEnrollTask({ questionMd: 'q', studentAnswerMd: 'a', profile, runTaskFn }),
    ).rejects.toBeInstanceOf(MistakeEnrollTaskError);
  });

  it('throws MistakeEnrollTaskError on schema-invalid output', async () => {
    const runTaskFn = stub({ ...FAILURE_JSON, difficulty: 9 }); // difficulty out of 1..5
    await expect(
      runMistakeEnrollTask({ questionMd: 'q', studentAnswerMd: 'a', profile, runTaskFn }),
    ).rejects.toBeInstanceOf(MistakeEnrollTaskError);
  });

  it('fails loud when the default runner is used without ctx.db (no opaque LLM error)', async () => {
    // No runTaskFn injected → default runner path → ctx.db is required.
    await expect(
      runMistakeEnrollTask({ questionMd: 'q', studentAnswerMd: 'a', profile }),
    ).rejects.toThrow(/ctx with \{ db \}/);
  });
});
