import type { TaskDefinition } from './task-spec';

export type { ModelId, Provider, TaskBudget, TaskPrompt } from './task-spec';
export type TaskDef = TaskDefinition;
export type TaskCatalog = Readonly<Record<string, TaskDefinition>>;
export type TaskKindOf<Catalog extends TaskCatalog> = Extract<keyof Catalog, string>;

/** Preserve the injected catalog's identity and exact keys, without global registration. */
export function createTaskRegistry<const Catalog extends TaskCatalog>(
  catalog: Catalog,
): Readonly<Catalog> {
  return Object.freeze(catalog);
}
