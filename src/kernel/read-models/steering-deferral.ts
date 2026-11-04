// YUK-1770 D4 — the deferred-review KC set read by the due-list path.
//
// 「这周别排物理」: every KC whose reviews an in-window subtractive steering
// goal excludes. The due query filters these KCs out of its candidate pool —
// nothing is deleted, no FSRS state changes; when the window closes (or the
// learner revokes), the ordinary forgetting-risk ordering serves them again.

import { learnerLocalDay } from '@/core/learner-day';
import {
  steeringExcludedKnowledgeIds,
  steeringIsSubtractive,
  steeringWindowCoversToday,
} from '@/core/steering';
import type { Db, Tx } from '@/db/client';
import { listActiveSteeringGoals } from '@/kernel/read-models/active-goal-scope';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';

type DbLike = Db | Tx;

/**
 * Union of excluded KC ids across all in-window subtractive steering goals.
 * Empty set when no steering defers anything (the common case — one cheap
 * goal read short-circuits before any subject resolution).
 */
export async function loadSteeringDeferredKnowledgeIds(
  db: DbLike,
  now: Date,
): Promise<Set<string>> {
  const steerings = await listActiveSteeringGoals(db);
  const today = learnerLocalDay(now);
  const active = steerings.filter(
    (g): g is typeof g & { steering: NonNullable<typeof g.steering> } =>
      g.steering !== null &&
      steeringWindowCoversToday(g, today) &&
      steeringIsSubtractive(g.steering),
  );
  if (active.length === 0) return new Set();

  const subjectIds = [...new Set(active.flatMap((g) => g.steering.excluded_subject_ids))];
  const subjectKnowledgeIds = new Map<string, readonly string[]>();
  for (const subjectId of subjectIds) {
    // One resolve per distinct subject (mirror of active-goal-scope).
    subjectKnowledgeIds.set(subjectId, await resolveSubjectKnowledgeIds(db, subjectId));
  }

  const deferred = new Set<string>();
  for (const g of active) {
    for (const kc of steeringExcludedKnowledgeIds(g.steering, subjectKnowledgeIds)) {
      deferred.add(kc);
    }
  }
  return deferred;
}
