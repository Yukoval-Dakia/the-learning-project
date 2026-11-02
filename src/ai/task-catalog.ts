/**
 * Task catalog — immutable composer for owner-supplied TaskSpecs.
 *
 * Enforced at module load: each spec has exactly one owner, its map key equals
 * spec.kind, and the composed map is frozen. Task definitions stay static: no
 * mutable registration, filesystem/glob discovery, dynamic import, or
 * env-selected owner.
 */

import type { TaskOwner } from './owned-task-specs';
import type { TaskDefinition } from './task-spec';

export type { TaskOwner } from './owned-task-specs';
export { defineOwnedTaskSpecs } from './owned-task-specs';

export type OwnerTaskSpecs<Specs extends object = object> = {
  readonly owner: TaskOwner;
  readonly specs: Specs;
};

type CatalogFromOwnerMaps<OwnerMaps extends readonly OwnerTaskSpecs[]> =
  UnionToIntersection<OwnerMaps[number]['specs']> extends infer Entries
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
