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
import type { TaskDefinition } from './task-spec';

export type TaskOwner = 'practice' | 'ingestion' | 'knowledge' | 'notes' | 'agency' | 'copilot';

export interface OwnerTaskSpecs {
  owner: TaskOwner;
  specs: Record<string, TaskDefinition>;
}

/**
 * Validate one owner's spec map: each key must equal specs[key].kind, and each
 * spec must have non-empty prompt text/builder, provider, model, and budget.
 * Returns the validated map (identity — throws on violation).
 */
export function defineOwnedTaskSpecs(
  owner: TaskOwner,
  specs: Record<string, TaskDefinition>,
): Record<string, TaskDefinition> {
  for (const [key, def] of Object.entries(specs)) {
    if (key !== def.kind) {
      throw new Error(
        `defineOwnedTaskSpecs(${owner}): key "${key}" does not match spec.kind "${def.kind}"`,
      );
    }
    if (!def.defaultProvider) {
      throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" missing defaultProvider`);
    }
    if (!def.defaultModel) {
      throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" missing defaultModel`);
    }
    if (!def.budget || typeof def.budget.maxIterations !== 'number') {
      throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" missing or invalid budget`);
    }
    const p = def.prompt;
    if (!p) {
      throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" missing prompt`);
    }
    if (p.kind === 'inline' && !p.text.trim()) {
      throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" has empty inline prompt text`);
    }
    if (p.kind === 'profile' && typeof p.build !== 'function') {
      throw new Error(
        `defineOwnedTaskSpecs(${owner}): "${key}" profile prompt.build is not a function`,
      );
    }
  }
  return specs;
}

/**
 * Merge all owner spec maps into one frozen readonly map keyed by TaskKind.
 * Throws on duplicate kinds across owners.
 */
export function composeTaskCatalog(
  ownerMaps: OwnerTaskSpecs[],
): Readonly<Record<string, TaskDefinition>> {
  const result: Record<string, TaskDefinition> = {};
  const kindToOwner: Record<string, TaskOwner> = {};

  for (const { owner, specs } of ownerMaps) {
    for (const [kind, def] of Object.entries(specs)) {
      if (Object.hasOwn(result, kind)) {
        throw new Error(
          `composeTaskCatalog: duplicate kind "${kind}" — owned by both "${kindToOwner[kind]}" and "${owner}"`,
        );
      }
      result[kind] = def;
      kindToOwner[kind] = owner;
    }
  }

  return Object.freeze(result);
}

/**
 * The composed, frozen catalog of all 51 TaskDefinitions.
 * Indexed by TaskKind string. Runtime may index this by kind.
 */
export const taskCatalog: Readonly<Record<string, TaskDefinition>> = composeTaskCatalog([
  { owner: 'practice', specs: practiceTaskSpecs },
  { owner: 'ingestion', specs: ingestionTaskSpecs },
  { owner: 'knowledge', specs: knowledgeTaskSpecs },
  { owner: 'notes', specs: notesTaskSpecs },
  { owner: 'agency', specs: agencyTaskSpecs },
  { owner: 'copilot', specs: copilotTaskSpecs },
]);
