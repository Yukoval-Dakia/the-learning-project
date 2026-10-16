// Shared goal→placement KC scope resolution (YUK-481 → YUK-516).
//
// Three-tier dynamic scope resolution, single source of truth for BOTH the probe entrypoint
// (placement-start) and the placement-done profile read (placement-profile). YUK-516: the two
// had drifted — start resolved three tiers while the profile stayed frozen-only, so a
// cold-start goal placed via tier-2/3 read back an EMPTY profile. Sharing one resolver kills
// the drift class, not just the instance.
//
// A cold-start goal is declared on an empty tree (goal-create.ts: empty resolved scope is
// ALLOWED), so its FROZEN scope_knowledge_ids stays empty even after uploads bridge new child
// KCs. A frozen-only read would make placement permanently blind to those KCs. subject = view:
// scope is a DERIVED axis recomputed each call — the resolved set is never written back onto
// the goal row. See docs/design/2026-06-20-cold-start-day-one-design.md / YUK-481.

import type { Db, Tx } from '@/db/client';
import {
  batchResolveEffectiveDomains,
  resolveAllActiveKnowledgeIds,
  resolveSubjectKnowledgeIds,
} from '@/kernel/read-models/knowledge-tree';

export async function resolveGoalPlacementScope(
  db: Db | Tx,
  goalRow: {
    scope: string[] | null;
    subjectId: string | null;
    /** YUK-603 — goal.scope_mode; callers default an unknown/absent goal to 'explicit'. */
    scopeMode: 'explicit' | 'subject_live';
  },
): Promise<string[]> {
  const frozenScope = goalRow.scope ?? [];
  // Tier 1 (YUK-603 gate): ONLY an EXPLICIT goal's non-empty frozen scope short-circuits —
  // that set is a hand-picked / proposal-confirmed narrow authority, respected as-is and never
  // widened. A subject_live goal NEVER reads frozen (its column is [] by invariant; even a
  // stale non-empty value on a legacy row must not pin the scope — that pin was the armed bug).
  if (goalRow.scopeMode === 'explicit' && frozenScope.length > 0) return frozenScope;
  // Tier 2 (YUK-482 Lane B): frozen empty AND the goal carries a subject → RE-RESOLVE the
  // subject's KC set LIVE (effective-domain axis, alias-aware), so newly-bridged KCs enter
  // scope.
  let knowledgeIds: string[] = [];
  if (goalRow.subjectId) {
    knowledgeIds = await resolveSubjectKnowledgeIds(db, goalRow.subjectId);
  }
  // Tier 3 (YUK-481): subject resolution still yielded nothing — no subject_id, an unknown
  // subject string, or a subject whose root is planted but has no child KC yet. Fall back to
  // the FULL active tree rather than nothing, so the cold-start probe/profile stay reachable.
  // Downstream keeps the wide scope honest (selectNextPlacementItem serves only KCs with ≥1
  // eligible question; the profile surfaces untested KCs as explicit tested:false rows).
  if (knowledgeIds.length === 0) {
    knowledgeIds = await resolveAllActiveKnowledgeIds(db);
    // YUK-603 (review F6) — §5.4's anchor-not-content invariant holds on the wide fallback
    // too: synthetic subject roots are stripped so a subject_live goal that fell through an
    // empty tier-2 doesn't re-admit them (the profile would render them as fake untested
    // rows). EXCEPT when stripping would empty the scope — a roots-only day-one tree must
    // stay reachable so the probe reports an honest sourcingNeeded instead of 400ing.
    const contentOnly = knowledgeIds.filter((id) => !SYNTHETIC_SUBJECT_ROOT_RE.test(id));
    if (contentOnly.length > 0) knowledgeIds = contentOnly;
  }
  return knowledgeIds;
}

/**
 * YUK-1405 L2 — the "nearby" scope for a cold placement target: the probe's own KC
 * set UNIONED with every same-subject KC set the scope touches. Two sources of
 * subject identity: the probe goal's `subject_id` (when the probe is goal-bound)
 * and each scope KC's effective domain (subject = derived view, never a column),
 * so an explicit-knowledgeIds probe with no goal still widens to its own subjects.
 *
 * Returns scope ∪ nearby KCs (superset of the input; equal when nothing widens —
 * e.g. a subject_live probe whose scope IS already the subject set, or a domain
 * that labels no other nodes). Selection over this set still runs
 * selectNextPlacementItem → decideAutomaticServing, so widening can only serve an
 * already-admitted, automatically gradable item — never a non-gradable one.
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

// The seed-root id family ('seed:<subjectId>:root', seed.ts / ensureSubjectRoot). Pattern form
// because tier-3 is subject-agnostic; domain.ts's tier-2 exclusion stays exact-id (it knows its
// canonical subject). 3a runtime topic roots (newId + parent_id null) never match.
// YUK-1037 — exported as the single pattern for the anchor-not-content id family: every
// material_fsrs_state enrollment fed by question.knowledge_ids skips these ids (the subject
// read axis already excludes them — resolveSubjectKnowledgeIds), so a coarse-fallback
// 'seed:<subj>:root' binding can never mint a knowledge-level due card.
export const SYNTHETIC_SUBJECT_ROOT_RE = /^seed:[^:]+:root$/;
