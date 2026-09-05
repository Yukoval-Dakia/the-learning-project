import { taskCatalog } from './task-catalog';
import type { TaskDefinition } from './task-spec';

export type { ModelId, Provider, TaskBudget, TaskPrompt } from './task-spec';

export type TaskDef = TaskDefinition;

/** Browser-safe exact alias of the capability-owned TaskSpec catalog. */
export const tasks = taskCatalog;

export type TaskKind = keyof typeof tasks;
