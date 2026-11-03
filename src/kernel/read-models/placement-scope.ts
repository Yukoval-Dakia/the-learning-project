// Shared goal→placement KC scope resolution.
// Single source of truth for the probe entrypoint, the starter recovery sweeper and the
// placement-done profile read. They previously drifted, so a cold-start goal placed via derived
// scope read back an empty profile.
// A cold-start goal is declared on an empty tree, so its frozen scope_knowledge_ids stays
// empty even after uploads bridge new child KCs. Scope is a derived axis recomputed each
// call; the resolved set is never written back onto the goal row.

import type { Db, Tx } from '@/db/client';
import {
  batchResolveEffectiveDomains,
  resolveSubjectKnowledgeIds,
} from '@/kernel/read-models/knowledge-tree';

export async function resolveGoalPlacementScope(
  db: Db | Tx,
  goalRow: {
    scope: string[] | null;
    subjectId: string | null;
    /** goal.scope_mode; callers default an unknown/absent goal to 'explicit'. */
    scopeMode: 'explicit' | 'subject_live';
  },
): Promise<string[]> {
  const frozenScope = goalRow.scope ?? [];
  // Only an explicit goal's non-empty frozen scope short-circuits: it is a hand-picked or
  // proposal-confirmed narrow authority, respected as-is and never widened. A subject_live
  // goal never reads frozen (its column is [] by invariant); a stale non-empty value on a
  // legacy row must not pin the scope.
  if (goalRow.scopeMode === 'explicit' && frozenScope.length > 0) return frozenScope;
  // Otherwise the scope is the goal's own subject, re-resolved live (effective-domain axis,
  // alias-aware) so newly bridged KCs enter scope. It never widens to other subjects: a
  // subject with no content KC yet resolves to [], which is exactly the cold state the probe
  // answers with this subject's starter supply. Widening would let another subject's
  // questions count as servable and suppress that supply.
  if (!goalRow.subjectId) return [];
  return resolveSubjectKnowledgeIds(db, goalRow.subjectId);
}

/**
 * The "nearby" scope for a cold placement target: the probe's own KC set unioned with
 * every same-subject KC set the scope touches. Subject identity comes from the probe goal's
 * `subject_id` and from each KC's effective domain, so an explicit-knowledgeIds probe with
 * no goal still widens to its subjects.
 *
 * Returns a superset of the input (equal when nothing widens). Selection over this set
 * still runs selectNextPlacementItem → decideAutomaticServing, so widening can only serve
 * an already-admitted, automatically gradable item.
 */
export async function resolveNearbyPlacementScope(
  db: Db | Tx,
  knowledgeIds: readonly string[],
  subjectId?: string | null,
): Promise<string[]> {
  const scope = new Set(knowledgeIds.map((k) => k.trim()).filter((k) => k.length > 0));
  const subjects = new Set<string>();
  if (subjectId) subjects.add(subjectId);
  if (scope.size > 0) {
    const domains = await batchResolveEffectiveDomains(db, [...scope]);
    for (const domain of domains.values()) {
      if (domain) subjects.add(domain);
    }
  }
  if (subjects.size === 0) return [...scope];
  const subjectKcSets = await Promise.all(
    [...subjects].map((subject) => resolveSubjectKnowledgeIds(db, subject)),
  );
  for (const kcSet of subjectKcSets) {
    for (const id of kcSet) scope.add(id);
  }
  return [...scope];
}

// The seed-root id family ('seed:<subjectId>:root'). Pattern form so subject-agnostic readers
// can test any id; the subject read axis excludes these ids exactly. Runtime topic roots
// (newId + parent_id null) never match. Exported as the single pattern for the
// anchor-not-content family: every material_fsrs_state enrollment fed by
// question.knowledge_ids skips these ids, so a coarse 'seed:<subj>:root' binding cannot
// mint a knowledge-level due card.
export const SYNTHETIC_SUBJECT_ROOT_RE = /^seed:[^:]+:root$/;
