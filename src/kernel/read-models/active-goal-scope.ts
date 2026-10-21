// Active-goal effective-scope read model. Agency keeps goal writes and the scope
// vocabulary; this module only projects stored rows.

import { asc, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';

type DbLike = Db | Tx;

export interface ActiveGoal {
  id: string;
  title: string;
  subject_id: string | null;
  scope_knowledge_ids: string[];
  scope_mode: (typeof goal.$inferSelect)['scope_mode'];
  sequence_hint: number;
}

/**
 * Active goals in sequence_hint order, fed into the Coach input. Read-only; it does
 * not touch the FSRS-due / review backbone.
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
 * Active goals with effective scope: explicit keeps the frozen ids verbatim;
 * subject_live re-derives the subject's KC set at read time. One resolve per
 * distinct subject.
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
