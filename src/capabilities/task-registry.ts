// YUK-1062 — concrete task runtime composition; shared ai/ receives this catalog.
import { createTaskRegistry } from '@/ai/registry';
import { createTaskBudgetReaders } from '@/ai/task-budget';
import { createTaskPromptReaders } from '@/ai/task-prompts';
import { taskCatalog } from './task-catalog';

export type { ModelId, Provider, TaskBudget, TaskDef, TaskPrompt } from '@/ai/registry';
export type { TaskBudgetOverride } from '@/ai/task-budget';
export { LEARNER_LOCALE_PIN, getLearnerLocale } from '@/ai/task-prompts';

export const tasks = createTaskRegistry(taskCatalog);
export type TaskKind = keyof typeof tasks;
export type AiTaskKind = TaskKind;
export const { resolveTaskBudget, taskBudgetWiring, taskBudgetFacts } =
  createTaskBudgetReaders(tasks);
export const { getTaskSystemPrompt, isAiTaskKind } = createTaskPromptReaders(tasks);
