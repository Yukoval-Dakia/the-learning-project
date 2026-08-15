import { z } from 'zod';

import { tasks } from '@/ai/registry';
import { QuestionAuthorIntentSchema } from '@/ai/task-intents';
import type { Db } from '@/db/client';
import { GoalScopeIntentSchema } from '@/kernel/task-intents';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { type BoundRunTaskFn, type RunTaskCallCtx, makeRunTaskFn } from '@/server/ai/runner-fn';

export const RunTaskInputSchema = z
  .object({
    task_kind: z.enum(['GoalScopeTask', 'QuestionAuthorTask']),
    intent: z.union([GoalScopeIntentSchema, QuestionAuthorIntentSchema]),
  })
  .strict();

export const RunTaskOutputSchema = z.object({
  task_kind: z.string(),
  text: z.string(),
  task_run_id: z.string().nullable(),
  cost_usd: z.number().nullable(),
  cost_basis: z.enum(['reported', 'estimated', 'unknown']),
  cost_ref: z.string(),
  finish_reason: z.string().nullable(),
});

type RunTaskInput = z.infer<typeof RunTaskInputSchema>;
type RunTaskOutput = z.infer<typeof RunTaskOutputSchema>;
type GoalScopeIntent = z.infer<typeof GoalScopeIntentSchema>;
type QuestionAuthorIntent = z.infer<typeof QuestionAuthorIntentSchema>;

type IntentSchema<Intent> = { readonly parse: (value: unknown) => Intent };
type Prepare<Intent> = (
  ctx: ToolContext,
  intent: Intent,
) => Promise<{ readonly input: unknown; readonly ctx?: RunTaskCallCtx }>;
type RunTaskDeclaration<Intent> = {
  readonly intentSchema: IntentSchema<Intent>;
  readonly loadPrepare: () => Promise<Prepare<Intent>>;
};
type RunTaskDeclarations = {
  readonly GoalScopeTask: RunTaskDeclaration<GoalScopeIntent>;
  readonly QuestionAuthorTask: RunTaskDeclaration<QuestionAuthorIntent>;
};
type RunTaskExecutorDependencies = {
  readonly declarations: RunTaskDeclarations;
  readonly bindRunner: (baseContext: RunTaskCallCtx, db: Db) => BoundRunTaskFn;
};

const productionDeclarations = {
  GoalScopeTask: {
    intentSchema: tasks.GoalScopeTask.copilot.intentSchema,
    loadPrepare: tasks.GoalScopeTask.copilot.prepare,
  },
  QuestionAuthorTask: {
    intentSchema: tasks.QuestionAuthorTask.copilot.intentSchema,
    loadPrepare: tasks.QuestionAuthorTask.copilot.prepare,
  },
} satisfies RunTaskDeclarations;

export function createRunTaskExecutor(dependencies: RunTaskExecutorDependencies) {
  return async (
    ctx: ToolContext,
    input: { readonly task_kind: string; readonly intent: unknown },
  ) => {
    const prepared = await prepareRunTask(dependencies.declarations, ctx, input);
    const result = await dependencies.bindRunner(
      {
        signal: ctx.signal,
        parentTaskRunId: ctx.taskRunId,
        ...(ctx.providerSessionDeadlineAt !== undefined
          ? { providerSessionDeadlineAt: ctx.providerSessionDeadlineAt }
          : {}),
      },
      ctx.db,
    )(input.task_kind, prepared.input, prepared.ctx);
    return {
      task_kind: input.task_kind,
      text: result.text,
      task_run_id: result.task_run_id ?? null,
      cost_usd: result.cost_usd ?? null,
      cost_basis: result.cost_basis,
      cost_ref: result.cost_ref,
      finish_reason: result.finishReason ?? null,
    };
  };
}

const executeRunTask = createRunTaskExecutor({
  declarations: productionDeclarations,
  bindRunner: (baseContext, db) => makeRunTaskFn(db, baseContext),
});

export const runTaskTool: DomainTool<RunTaskInput, RunTaskOutput> = {
  name: 'run_task',
  description:
    'Run one approved generation-only task: GoalScopeTask accepts intent { goal_title, subject_id? }; QuestionAuthorTask accepts intent { seed_mode, knowledge_ids, requested_kind?, difficulty?, material_body_md?, material_title? }. Returns audited generation output only and never persists drafts or proposals; use author_question for a retained question draft/proposal.',
  effect: 'read',
  inputSchema: RunTaskInputSchema,
  outputSchema: RunTaskOutputSchema,
  costClass: 'expensive_llm',
  async execute(ctx, input) {
    return executeRunTask(ctx, input);
  },
  summarize(input) {
    return `run_task · ${input.task_kind}`;
  },
  mirrorEvent: 'when_user_visible',
};

async function prepareRunTask(
  declarations: RunTaskDeclarations,
  ctx: ToolContext,
  input: { readonly task_kind: string; readonly intent: unknown },
) {
  switch (input.task_kind) {
    case 'GoalScopeTask': {
      const intent = declarations.GoalScopeTask.intentSchema.parse(input.intent);
      const prepare = await declarations.GoalScopeTask.loadPrepare();
      return prepare(ctx, intent);
    }
    case 'QuestionAuthorTask': {
      const intent = declarations.QuestionAuthorTask.intentSchema.parse(input.intent);
      const prepare = await declarations.QuestionAuthorTask.loadPrepare();
      return prepare(ctx, intent);
    }
    default:
      if (Object.hasOwn(tasks, input.task_kind)) {
        throw new Error(`run_task: task '${input.task_kind}' is not invocable`);
      }
      throw new Error(`run_task: unknown task kind '${input.task_kind}'`);
  }
}
