// YUK-1770 D4 — the deferred KC set for in-window subtractive steering.
//
// 「这周别排物理」: every KC an in-window subtractive steering goal excludes.
// Due review, the daily practice composer, and automatic supply-target
// generation read this set. Nothing is deleted and no FSRS state changes;
// when the window closes (or the learner revokes), ordinary ordering serves
// those KCs again. A candidate leaves only when every one of its knowledge
// ids is in the set (`steeringDefersKnowledgeIds`).

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
