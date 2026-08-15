/**
 * task-catalog.ts — central composition root for all 51 TaskDefinition specs.
 *
 * YUK-863 / F3.2 — Census and compose 51 owner TaskSpecs.
 *
 * Rules (enforced at module load):
 *  - Each spec appears under exactly one owner.
 *  - The map key must equal spec.kind.
 *  - Every spec must carry non-empty prompt, provider, model, budget, and
 *    tool metadata (plus structuredOutputSchema when needed).
 *  - No mutable registration: the returned map is frozen after composition.
 *
 * Forbidden patterns (do NOT reintroduce):
 *  - registerTask / setTask / global service-locator mutations
 *  - filesystem / glob scan at import time
 *  - env-selected owner or fallback owner
 *  - dynamic import() task discovery
 */

import { agencyTaskSpecs } from '@/capabilities/agency/tasks/index';
import { copilotTaskSpecs } from '@/capabilities/copilot/tasks/index';
import { ingestionTaskSpecs } from '@/capabilities/ingestion/tasks/index';
import { knowledgeTaskSpecs } from '@/capabilities/knowledge/tasks/index';
import { notesTaskSpecs } from '@/capabilities/notes/tasks/index';
import { practiceTaskSpecs } from '@/capabilities/practice/tasks/index';
import type { TaskOwner } from './owned-task-specs';
import type { TaskDefinition } from './task-spec';

export { defineOwnedTaskSpecs } from './owned-task-specs';
export type { TaskOwner } from './owned-task-specs';

export type OwnerTaskSpecs<Specs extends object = object> = {
  readonly owner: TaskOwner;
  readonly specs: Specs;
};

type CatalogFromOwnerMaps<OwnerMaps extends readonly OwnerTaskSpecs[]> = UnionToIntersection<
  OwnerMaps[number]['specs']
> extends infer Entries
  ? {
      readonly [Kind in keyof Entries]: Entries[Kind] extends {
        readonly definition: infer Definition;
      }
        ? Definition
        : never;
    }
  : never;

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

/**
 * Merge all owner spec maps into one frozen readonly map keyed by TaskKind.
 * Throws on duplicate kinds across owners.
 */
export function composeTaskCatalog<const OwnerMaps extends readonly OwnerTaskSpecs[]>(
  ownerMaps: OwnerMaps,
  expectedCount?: number,
): Readonly<CatalogFromOwnerMaps<OwnerMaps>> {
  const result: Record<string, TaskDefinition> = {};
  const kindToOwner = new Map<string, TaskOwner>();
  const owners = new Set<TaskOwner>();

  for (const { owner, specs } of ownerMaps) {
    if (owners.has(owner)) {
      throw new Error(`composeTaskCatalog: duplicate owner "${owner}"`);
    }
    owners.add(owner);
    for (const [kind, entry] of Object.entries(specs)) {
      if (typeof entry !== 'object' || entry === null || !('definition' in entry)) {
        throw new Error(`composeTaskCatalog(${owner}): "${kind}" is not a task owner entry`);
      }
      const def = entry.definition as TaskDefinition;
      if (kind !== def.kind) {
        throw new Error(
          `composeTaskCatalog(${owner}): key "${kind}" does not match spec.kind "${def.kind}"`,
        );
      }
      if (Object.hasOwn(result, kind)) {
        throw new Error(
          `composeTaskCatalog: duplicate kind "${kind}" — owned by both "${kindToOwner.get(kind)}" and "${owner}"`,
        );
      }
      result[kind] = def;
      kindToOwner.set(kind, owner);
    }
  }

  if (expectedCount !== undefined && Object.keys(result).length !== expectedCount) {
    throw new Error(
      `composeTaskCatalog: expected ${expectedCount} definitions, received ${Object.keys(result).length}`,
    );
  }

  return Object.freeze(result) as Readonly<CatalogFromOwnerMaps<OwnerMaps>>;
}

/**
 * The composed, frozen catalog of all 51 TaskDefinitions.
 * Indexed by TaskKind string. Runtime may index this by kind.
 */
export const taskCatalog = composeTaskCatalog(
  [
    { owner: 'practice', specs: practiceTaskSpecs },
    { owner: 'ingestion', specs: ingestionTaskSpecs },
    { owner: 'knowledge', specs: knowledgeTaskSpecs },
    { owner: 'notes', specs: notesTaskSpecs },
    { owner: 'agency', specs: agencyTaskSpecs },
    { owner: 'copilot', specs: copilotTaskSpecs },
  ] as const,
  51,
);
