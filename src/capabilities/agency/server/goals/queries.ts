// Goal reads and backward-compatible semantic command entrypoints.
// Live creation and mutation rules belong to commands.ts. insertGoal is retained
// only for historical import/test fixtures; it deliberately does not synthesize events.

import { asc, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import { type GoalScopeMode, type GoalStatus, mutateGoal } from './commands';

type DbLike = Db | Tx;

export type { GoalScopeMode, GoalStatus, InsertGoalInput } from './commands';
export { insertLegacyGoal as insertGoal } from './commands';

export interface ActiveGoal {
  id: string;
  title: string;
  subject_id: string | null;
  scope_knowledge_ids: string[];
  scope_mode: GoalScopeMode;
  sequence_hint: number;
}

/**
 * Transition a goal's status. ND-4: status is qualitative (active / dormant /
 * done) — never a progress percentage. Optimistic-concurrency bump on version.
 */
export async function updateGoalStatus(
  db: DbLike,
  goalId: string,
  status: GoalStatus,
  now: Date = new Date(),
): Promise<void> {
  await mutateGoal(db, goalId, { kind: 'status', status, actorRef: 'goal-status-update', now });
}

/**
 * Re-scope a goal (title / scope_knowledge_ids / sequence_hint). Used when the
 * AI re-proposes scope after the user progresses (ND-2 — still routed through a
 * confirmed proposal, never a silent change). `source` / `subject_id` are
 * set-once provenance and intentionally not mutated here.
 */
export async function updateGoalScope(
  db: DbLike,
  goalId: string,
  patch: {
    title?: string;
    scope_knowledge_ids?: string[];
    sequence_hint?: number;
    placement_starter_augmentation?: boolean;
  },
  now: Date = new Date(),
  actorRef = 'goal-scope-update',
): Promise<void> {
  // Lock/read/version capture must happen in the same transaction as the event and row write.
  // Reading `existing` before this boundary permits a concurrent owner update to be overwritten
  // by a stale replacement patch after the row lock is eventually acquired.
  await mutateGoal(db, goalId, { kind: 'scope', ...patch, actorRef, now });
}

/**
 * Active goals ordered by sequence_hint then created_at. Fed into the Coach
 * input so it can distribute the goal strand across them (round-robin + weakest
 * first per ADR-0025 §3 v0). This is a read-only ADD to the Coach signal set —
 * it does not touch the FSRS-due / review backbone (ND-5).
 */
export async function listActiveGoals(db: DbLike): Promise<ActiveGoal[]> {
  const rows = await db
    .select({
      id: goal.id,
      title: goal.title,
      subject_id: goal.subject_id,
      scope_knowledge_ids: goal.scope_knowledge_ids,
      scope_mode: goal.scope_mode,
      sequence_hint: goal.sequence_hint,
    })
    .from(goal)
    .where(eq(goal.status, 'active'))
    .orderBy(asc(goal.sequence_hint), asc(goal.created_at));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subject_id: r.subject_id,
    scope_knowledge_ids: r.scope_knowledge_ids ?? [],
    scope_mode: r.scope_mode,
    sequence_hint: r.sequence_hint,
  }));
}

/**
 * YUK-603 (v2 contract §5.3 read path) — active goals with their EFFECTIVE scope:
 * explicit → the frozen scope_knowledge_ids verbatim; subject_live → the subject's KC set
 * re-derived at read time (effective-domain axis, synthetic root excluded at the source).
 *
 * This is the goal-strand readers' default (coach_daily / dreaming_nightly / due-list rerank /
 * learner-state): they previously read the frozen column with NO live tier at all, so a subject
 * goal's pinned scope silently blinded them. One resolve per DISTINCT subject (Map-deduped) —
 * no caching subsystem (single-user, hundreds of nodes; see §9⑨ cost prerequisite).
 */
export async function listActiveGoalsWithResolvedScope(db: DbLike): Promise<ActiveGoal[]> {
  const goals = await listActiveGoals(db);
  const bySubject = new Map<string, string[]>();
  for (const g of goals) {
    if (g.scope_mode !== 'subject_live' || !g.subject_id) continue;
    if (!bySubject.has(g.subject_id)) {
      bySubject.set(g.subject_id, await resolveSubjectKnowledgeIds(db, g.subject_id));
    }
  }
  return goals.map((g) =>
    g.scope_mode === 'subject_live'
      ? { ...g, scope_knowledge_ids: g.subject_id ? (bySubject.get(g.subject_id) ?? []) : [] }
      : g,
  );
}
