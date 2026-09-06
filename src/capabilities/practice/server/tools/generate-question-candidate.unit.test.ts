import { describe, expect, it, vi } from 'vitest';

import { QuestionAuthorIntentSchema } from '@/ai/task-intents';
import type { RunTaskCallCtx } from '@/server/ai/runner-fn';
import { resolveSubjectProfile } from '@/subjects/profile';
import { parseQuestionAuthorOutput } from '../../tasks/question-author';
import {
  createGenerateQuestionCandidateExecutor,
  generateQuestionCandidateTool,
} from './generate-question-candidate';
import type { prepareQuestionAuthorTask } from './question-author';

const writes = {
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
};
const db = writes as never;
const abortController = new AbortController();
const ctx = {
  db,
  taskRunId: 'parent_question_run',
  callerActor: { kind: 'agent' as const, ref: 'agent:copilot' },
  signal: abortController.signal,
  providerSessionDeadlineAt: 654_321,
};

describe('generate_question_candidate', () => {
  it('normalizes only absent optional author arrays, preserving answers and rejecting malformed data', () => {
    const draft = {
      kind: 'computation',
      difficulty: 1,
      knowledge_ids: ['distribution'],
      structured: {
        id: 'q1',
        role: 'standalone',
        prompt_text: '利用分配律计算 104×5。',
        answers: ['520'],
        analysis: '104×5=(100+4)×5=500+20=520。',
        options: null,
        sub_questions: null,
      },
    };
    const parsed = parseQuestionAuthorOutput(JSON.stringify(draft));
    expect(parsed.structured.options).toBeUndefined();
    expect(parsed.structured.sub_questions).toBeUndefined();
    expect(parsed.structured.answers).toEqual(['520']);
    expect(parsed.structured.analysis).toContain('500+20');
    for (const options of ['not-an-array', [{ label: 'A' }]])
      expect(() =>
        parseQuestionAuthorOutput(
          JSON.stringify({ ...draft, structured: { ...draft.structured, options } }),
        ),
      ).toThrow();
  });

  it('rejects invalid intent before owner preparation or any retained write', async () => {
    const prepare = vi.fn();
    const execute = createGenerateQuestionCandidateExecutor({
      prepare: prepare as unknown as typeof prepareQuestionAuthorTask,
      bindRunner: vi.fn(),
    });

    await expect(
      execute(ctx, { seed_mode: 'material', knowledge_ids: ['k1'], material_body_md: 'source' }),
    ).rejects.toThrow('material_answer_anchor');
    expect(prepare).not.toHaveBeenCalled();
    expect(writes.insert).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(writes.delete).not.toHaveBeenCalled();
    expect(writes.transaction).not.toHaveBeenCalled();
  });

  it('forwards cancellation, parent audit identity, deadline, and cost metadata without creating a draft', async () => {
    const profile = resolveSubjectProfile('math');
    const draft = {
      kind: 'computation',
      difficulty: 4,
      knowledge_ids: ['k1'],
      structured: {
        id: 'model-placeholder',
        role: 'standalone',
        prompt_text: '计算 17×19，并用分配律检验',
        answers: ['323'],
        analysis: '17×(20−1)=340−17=323。',
      },
      choices_md: null,
    };
    const prepare = vi.fn(async () => ({
      input: {
        seed_mode: 'knowledge',
        knowledge_context: [{ id: 'k1', name: 'Newton laws' }],
        requested_difficulty: 4,
      },
      ctx: { subjectProfile: profile },
    }));
    const run = vi.fn(async (_kind: string, _input: unknown, _ctx?: RunTaskCallCtx) => ({
      text: JSON.stringify({ ...draft, knowledge_ids: ['k1', 'hallucinated'] }),
      task_run_id: 'question_generation_run',
      cost_usd: 0.34,
      cost_basis: 'estimated' as const,
      cost_ref: 'usage:estimated',
      finishReason: 'stop',
      usage: { inputTokens: 34, outputTokens: 55 },
    }));
    const bindRunner = vi.fn(() => run);
    const execute = createGenerateQuestionCandidateExecutor({
      prepare: prepare as unknown as typeof prepareQuestionAuthorTask,
      bindRunner,
    });

    await expect(
      execute(ctx, { seed_mode: 'knowledge', knowledge_ids: ['k1'], difficulty: 4 }),
    ).resolves.toEqual({
      text: JSON.stringify(draft),
      subject_id: profile.id,
      task_run_id: 'question_generation_run',
      cost_usd: 0.34,
      cost_basis: 'estimated',
      cost_ref: 'usage:estimated',
      finish_reason: 'stop',
    });
    expect(prepare).toHaveBeenCalledWith(ctx, {
      seed_mode: 'knowledge',
      knowledge_ids: ['k1'],
      difficulty: 4,
    });
    expect(bindRunner).toHaveBeenCalledWith(
      {
        signal: abortController.signal,
        parentTaskRunId: 'parent_question_run',
        providerSessionDeadlineAt: 654_321,
      },
      db,
    );
    expect(run).toHaveBeenCalledWith(
      'QuestionAuthorTask',
      {
        seed_mode: 'knowledge',
        knowledge_context: [{ id: 'k1', name: 'Newton laws' }],
        requested_difficulty: 4,
      },
      { subjectProfile: profile },
    );
    expect(writes.insert).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(writes.delete).not.toHaveBeenCalled();
    expect(writes.transaction).not.toHaveBeenCalled();
  });

  it('keeps retained author_question distinct from the candidate-only contract', () => {
    expect(generateQuestionCandidateTool.effect).toBe('read');
    expect(
      generateQuestionCandidateTool.inputSchema.parse({
        seed_mode: 'knowledge',
        knowledge_ids: ['k1'],
      }),
    ).toEqual({ seed_mode: 'knowledge', knowledge_ids: ['k1'] });
    expect(() =>
      generateQuestionCandidateTool.inputSchema.parse({ task_kind: 'QuestionAuthorTask' }),
    ).toThrow();
    expect(
      QuestionAuthorIntentSchema.safeParse({
        seed_mode: 'knowledge',
        knowledge_ids: [],
        draft: true,
      }).success,
    ).toBe(false);
  });
});
