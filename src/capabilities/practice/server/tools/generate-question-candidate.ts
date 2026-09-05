import { z } from 'zod';

import { QuestionAuthorIntentSchema } from '@/ai/task-intents';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { type BoundRunTaskFn, type RunTaskCallCtx, makeRunTaskFn } from '@/server/ai/runner-fn';
import { prepareQuestionAuthorTask } from './question-author';

export const GenerateQuestionCandidateInputSchema = QuestionAuthorIntentSchema;

export const GenerateQuestionCandidateOutputSchema = z.object({
  text: z.string(),
  task_run_id: z.string().nullable(),
  cost_usd: z.number().nullable(),
  cost_basis: z.enum(['reported', 'estimated', 'unknown']),
  cost_ref: z.string(),
  finish_reason: z.string().nullable(),
});

type GenerateQuestionCandidateInput = z.infer<typeof GenerateQuestionCandidateInputSchema>;
type GenerateQuestionCandidateOutput = z.infer<typeof GenerateQuestionCandidateOutputSchema>;

type GenerateQuestionCandidateDependencies = {
  readonly prepare: typeof prepareQuestionAuthorTask;
  readonly bindRunner: (baseContext: RunTaskCallCtx, db: ToolContext['db']) => BoundRunTaskFn;
};

export function createGenerateQuestionCandidateExecutor(
  dependencies: GenerateQuestionCandidateDependencies,
) {
  return async (ctx: ToolContext, input: unknown): Promise<GenerateQuestionCandidateOutput> => {
    const intent = GenerateQuestionCandidateInputSchema.parse(input);
    const prepared = await dependencies.prepare(ctx, intent);
    const result = await dependencies.bindRunner(
      {
        signal: ctx.signal,
        parentTaskRunId: ctx.taskRunId,
        ...(ctx.providerSessionDeadlineAt !== undefined
          ? { providerSessionDeadlineAt: ctx.providerSessionDeadlineAt }
          : {}),
      },
      ctx.db,
    )('QuestionAuthorTask', prepared.input, prepared.ctx);

    return {
      text: result.text,
      task_run_id: result.task_run_id ?? null,
      cost_usd: result.cost_usd ?? null,
      cost_basis: result.cost_basis,
      cost_ref: result.cost_ref,
      finish_reason: result.finishReason ?? null,
    };
  };
}

const executeGenerateQuestionCandidate = createGenerateQuestionCandidateExecutor({
  prepare: prepareQuestionAuthorTask,
  bindRunner: (baseContext, db) => makeRunTaskFn(db, baseContext),
});

/**
 * Produces a one-shot question candidate only. It intentionally does not use
 * author_question, which remains the distinct retained draft/proposal surface.
 */
export const generateQuestionCandidateTool: DomainTool<
  GenerateQuestionCandidateInput,
  GenerateQuestionCandidateOutput
> = {
  name: 'generate_question_candidate',
  description:
    'Generate one question candidate from a validated knowledge or material intent. It validates and normalizes the owner preparation, then returns audited generation output only; it never creates a draft or proposal. Use author_question when a retained draft/proposal is intended.',
  effect: 'read',
  inputSchema: GenerateQuestionCandidateInputSchema,
  outputSchema: GenerateQuestionCandidateOutputSchema,
  costClass: 'expensive_llm',
  async execute(ctx, input) {
    return executeGenerateQuestionCandidate(ctx, input);
  },
  summarize(input) {
    return `generate_question_candidate · ${input.seed_mode}`;
  },
  mirrorEvent: 'when_user_visible',
};
