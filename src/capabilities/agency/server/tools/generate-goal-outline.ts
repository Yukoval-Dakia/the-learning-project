import { z } from 'zod';

import { GoalScopeIntentSchema } from '@/kernel/task-intents';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { type BoundRunTaskFn, type RunTaskCallCtx, makeRunTaskFn } from '../ai-runtime';
import { prepareGoalScopeTask } from '../goals/scope';

export const GenerateGoalOutlineInputSchema = GoalScopeIntentSchema;

export const GenerateGoalOutlineOutputSchema = z.object({
  text: z.string(),
  task_run_id: z.string().nullable(),
  cost_usd: z.number().nullable(),
  cost_basis: z.enum(['reported', 'estimated', 'unknown']),
  cost_ref: z.string(),
  finish_reason: z.string().nullable(),
});

type GenerateGoalOutlineInput = z.infer<typeof GenerateGoalOutlineInputSchema>;
type GenerateGoalOutlineOutput = z.infer<typeof GenerateGoalOutlineOutputSchema>;

type GenerateGoalOutlineDependencies = {
  readonly prepare: typeof prepareGoalScopeTask;
  readonly bindRunner: (baseContext: RunTaskCallCtx, db: ToolContext['db']) => BoundRunTaskFn;
};

export function createGenerateGoalOutlineExecutor(dependencies: GenerateGoalOutlineDependencies) {
  return async (ctx: ToolContext, input: unknown): Promise<GenerateGoalOutlineOutput> => {
    const intent = GenerateGoalOutlineInputSchema.parse(input);
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
    )('GoalScopeTask', prepared.input, prepared.ctx);

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

const executeGenerateGoalOutline = createGenerateGoalOutlineExecutor({
  prepare: prepareGoalScopeTask,
  bindRunner: (baseContext, db) => makeRunTaskFn(db, baseContext),
});

/**
 * Produces a one-shot goal outline only. It does not write a goal, draft, or
 * proposal; the retained goal-scope proposal workflow remains separately owned.
 */
export const generateGoalOutlineTool: DomainTool<
  GenerateGoalOutlineInput,
  GenerateGoalOutlineOutput
> = {
  name: 'generate_goal_outline',
  description:
    'Generate a goal scope outline from { goal_title, subject_id? }. Validates the goal intent and reads the current knowledge grid, then returns audited generation output only; it never writes goals, drafts, or proposals.',
  effect: 'read',
  inputSchema: GenerateGoalOutlineInputSchema,
  outputSchema: GenerateGoalOutlineOutputSchema,
  costClass: 'expensive_llm',
  async execute(ctx, input) {
    return executeGenerateGoalOutline(ctx, input);
  },
  summarize(input) {
    return `generate_goal_outline · ${input.goal_title}`;
  },
  mirrorEvent: 'when_user_visible',
};
