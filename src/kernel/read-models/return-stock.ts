// YUK-1560 — 空闲回来可练的库存缺口。按目标继承后的有效 domain 统计，
// 不读知识点行上的裸 domain（子节点通常是空的）。
// 可用题走 questionServingSet 的正式出题准入。

import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { goal, question } from '@/db/schema';
import { RETURN_STOCK_QUESTIONS } from '@/kernel/nightly-eligibility';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import { questionServingSet } from '@/kernel/read-models/question-serving';

export interface ReturnStockGap {
  subjectId: string | null;
  knowledgeIds: string[];
  usable: number;
  missing: number;
}

export async function loadReturnStockGaps(db: Db): Promise<ReturnStockGap[]> {
  const goals = await db
    .select({
      subjectId: goal.subject_id,
      scopeMode: goal.scope_mode,
      scopeKnowledgeIds: goal.scope_knowledge_ids,
    })
    .from(goal)
    .where(eq(goal.status, 'active'));
  const bySubject = new Map<string, string[]>();
  const gaps: ReturnStockGap[] = [];
  for (const active of goals) {
    const knowledgeIds = await scopeKnowledgeIds(db, active, bySubject);
    if (knowledgeIds.length === 0) continue;
    const usable = await countServableQuestions(db, knowledgeIds);
    if (usable >= RETURN_STOCK_QUESTIONS) continue;
    gaps.push({
      subjectId: active.subjectId,
      knowledgeIds,
      usable,
      missing: RETURN_STOCK_QUESTIONS - usable,
    });
  }
  return gaps;
}

async function scopeKnowledgeIds(
  db: Db,
  active: { subjectId: string | null; scopeMode: string; scopeKnowledgeIds: string[] },
  bySubject: Map<string, string[]>,
): Promise<string[]> {
  if (active.scopeMode === 'explicit') return active.scopeKnowledgeIds;
  if (!active.subjectId) return [];
  const cached = bySubject.get(active.subjectId);
  if (cached) return cached;
  const resolved = await resolveSubjectKnowledgeIds(db, active.subjectId);
  bySubject.set(active.subjectId, resolved);
  return resolved;
}

async function countServableQuestions(db: Db, knowledgeIds: string[]): Promise<number> {
  const ids = sql.join(
    knowledgeIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const serving = await questionServingSet(db, [
    sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${question.knowledge_ids}) elem
      WHERE elem IN (${ids})
    )`,
  ]);
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (${serving}) serving where servable
  `);
  for (const row of rows) return Number(row.n ?? 0);
  return 0;
}
