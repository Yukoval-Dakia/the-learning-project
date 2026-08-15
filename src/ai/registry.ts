import { GoalScopeIntentSchema } from '@/kernel/task-intents';
import type { RunTaskCallCtx } from '@/server/ai/runner-fn';
import type { ToolContext } from '@/server/ai/tools/types';
import type { ZodType } from 'zod';
import { taskCatalog } from './task-catalog';
import { QuestionAuthorIntentSchema } from './task-intents';
import type { TaskDefinition } from './task-spec';

export type { ModelId, Provider, TaskBudget, TaskPrompt } from './task-spec';

export type TaskPrepareResult = { readonly input: unknown; readonly ctx?: RunTaskCallCtx };
export type TaskPrepare = (ctx: ToolContext, intent: never) => Promise<TaskPrepareResult>;

export interface TaskDef extends TaskDefinition {
  readonly copilot?: {
    readonly intentSchema: ZodType<unknown>;
    readonly prepare: () => Promise<TaskPrepare>;
    readonly invocable: boolean;
  };
}

const goalScopeTask = Object.freeze({
  ...taskCatalog.GoalScopeTask,
  copilot: Object.freeze({
    intentSchema: GoalScopeIntentSchema,
    prepare: () =>
      import('@/capabilities/agency/server/goals/scope').then(
        (module) => module.prepareGoalScopeTask,
      ),
    invocable: true,
  }),
});

const questionAuthorTask = Object.freeze({
  ...taskCatalog.QuestionAuthorTask,
  copilot: Object.freeze({
    intentSchema: QuestionAuthorIntentSchema,
    prepare: () =>
      import('@/server/ai/question-author').then((module) => module.prepareQuestionAuthorTask),
    invocable: true,
  }),
});

export const tasks = Object.freeze({
  ...taskCatalog,
  GoalScopeTask: goalScopeTask,
  QuestionAuthorTask: questionAuthorTask,
});

export type TaskKind = keyof typeof tasks;
