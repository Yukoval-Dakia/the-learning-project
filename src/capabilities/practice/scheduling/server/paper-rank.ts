// Pending-paper order for the daily stream.
// A paper is ranked by how many knowledge points on its question rows sit in
// today's due, weak, misconception, and steering sets. The artifact's own tag
// list is not used: it can name points the paper's questions do not cover, or
// miss points they do. Import time is the last key, so an older paper is not
// buried when it covers the same points.
// Duration is not decided here: the caller prices a paper as its answerable
// slot count times the shared per-question pace.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { learnerLocalDay } from '@/core/learner-day';
import { MASTERY_BAND_THRESHOLDS } from '@/core/mastery-band';
import { steeringWindowCoversToday } from '@/core/steering';
import type { Db, Tx } from '@/db/client';
import { artifact, misconception, misconception_edge, question } from '@/db/schema';
import { listActiveGoalsWithResolvedScope } from '@/kernel/read-models/active-goal-scope';
import { getMasteryProjection, isObserved } from '@/kernel/read-models/mastery-projection';
import { countPaperSlots, paperQuestionIds } from '../../session/public';

type DbLike = Db | Tx;

export interface PendingPaperFacts {
  paperId: string;
  title: string;
  source: 'paper' | 'on_demand' | 'import';
  /** Knowledge points on the paper's question rows. */
  knowledgeIds: readonly string[];
  questionCount: number;
  createdAt: Date;
}

interface PaperRelevanceScope {
  due: ReadonlySet<string>;
  weak: ReadonlySet<string>;
  misconception: ReadonlySet<string>;
  steering: ReadonlySet<string>;
}

interface PaperRank {
  due: number;
  weak: number;
  misconception: number;
  steering: number;
}

function overlap(knowledgeIds: readonly string[], scope: ReadonlySet<string>): number {
  const seen = new Set<string>();
  for (const id of knowledgeIds) if (scope.has(id)) seen.add(id);
  return seen.size;
}

function paperRank(knowledgeIds: readonly string[], scope: PaperRelevanceScope): PaperRank {
  return {
    due: overlap(knowledgeIds, scope.due),
    weak: overlap(knowledgeIds, scope.weak),
    misconception: overlap(knowledgeIds, scope.misconception),
    steering: overlap(knowledgeIds, scope.steering),
  };
}

function comparePaperRank(left: PaperRank, right: PaperRank): number {
  return (
    right.due - left.due ||
    right.weak - left.weak ||
    right.misconception - left.misconception ||
    right.steering - left.steering
  );
}

/** Future or invalid timestamps tie with "just imported" and lose to any earlier paper. */
function importedAt(createdAt: Date, now: Date): number {
  const time = createdAt.getTime();
  const current = now.getTime();
  if (!Number.isFinite(time) || !Number.isFinite(current) || time > current) return current;
  return time;
}

async function weakKnowledgeIds(db: DbLike, knowledgeIds: readonly string[]): Promise<Set<string>> {
  const weak = new Set<string>();
  if (knowledgeIds.length === 0) return weak;
  const projection = await getMasteryProjection(db, [...knowledgeIds]);
  for (const [id, row] of projection) {
    if (!isObserved(row) || row.evidence_count <= 0) continue;
    if (row.mastery < MASTERY_BAND_THRESHOLDS.growing) weak.add(id);
  }
  return weak;
}

async function misconceptionKnowledgeIds(
  db: DbLike,
  knowledgeIds: readonly string[],
): Promise<Set<string>> {
  if (knowledgeIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ id: misconception_edge.to_id })
    .from(misconception_edge)
    .innerJoin(misconception, eq(misconception.id, misconception_edge.from_id))
    .where(
      and(
        eq(misconception_edge.relation_type, 'caused_by'),
        eq(misconception_edge.from_kind, 'misconception'),
        eq(misconception_edge.to_kind, 'knowledge'),
        inArray(misconception_edge.to_id, [...knowledgeIds]),
        isNull(misconception_edge.archived_at),
        eq(misconception.status, 'active'),
        isNull(misconception.archived_at),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

async function steeringScopeKnowledgeIds(db: DbLike, now: Date): Promise<Set<string>> {
  const today = learnerLocalDay(now);
  const goals = await listActiveGoalsWithResolvedScope(db);
  const scope = new Set<string>();
  for (const goal of goals) {
    if (goal.steering === null || !steeringWindowCoversToday(goal, today)) continue;
    for (const id of goal.scope_knowledge_ids) scope.add(id);
  }
  return scope;
}

async function loadPaperRelevanceScope(
  db: DbLike,
  papers: readonly PendingPaperFacts[],
  dueKnowledgeIds: ReadonlySet<string>,
  now: Date,
): Promise<PaperRelevanceScope> {
  const knowledgeIds = [...new Set(papers.flatMap((paper) => paper.knowledgeIds))];
  const [weak, misconception, steering] = await Promise.all([
    weakKnowledgeIds(db, knowledgeIds),
    misconceptionKnowledgeIds(db, knowledgeIds),
    steeringScopeKnowledgeIds(db, now),
  ]);
  return { due: dueKnowledgeIds, weak, misconception, steering };
}

export async function rankPendingPapers(
  db: DbLike,
  papers: readonly PendingPaperFacts[],
  dueKnowledgeIds: ReadonlySet<string>,
  now: Date,
): Promise<PendingPaperFacts[]> {
  if (papers.length <= 1) return [...papers];
  const scope = await loadPaperRelevanceScope(db, papers, dueKnowledgeIds, now);
  return [...papers].sort((left, right) => {
    const byRank = comparePaperRank(
      paperRank(left.knowledgeIds, scope),
      paperRank(right.knowledgeIds, scope),
    );
    return (
      byRank ||
      importedAt(left.createdAt, now) - importedAt(right.createdAt, now) ||
      left.paperId.localeCompare(right.paperId)
    );
  });
}

export async function attachPaperQuestionKnowledge(
  db: DbLike,
  papers: readonly PendingPaperFacts[],
): Promise<PendingPaperFacts[]> {
  if (papers.length === 0) return [];
  const states = await db
    .select({ id: artifact.id, tool_state: artifact.tool_state })
    .from(artifact)
    .where(
      inArray(
        artifact.id,
        papers.map((paper) => paper.paperId),
      ),
    );
  const questionIdsByPaper = new Map<string, string[]>();
  const questionIds = new Set<string>();
  for (const row of states) {
    const ids = paperQuestionIds(row.tool_state);
    questionIdsByPaper.set(row.id, ids);
    for (const id of ids) questionIds.add(id);
  }
  const knowledgeByQuestion = new Map<string, readonly string[]>();
  if (questionIds.size > 0) {
    const rows = await db
      .select({ id: question.id, knowledge_ids: question.knowledge_ids })
      .from(question)
      .where(inArray(question.id, [...questionIds]));
    for (const row of rows) knowledgeByQuestion.set(row.id, row.knowledge_ids);
  }
  return papers.map((paper) => {
    const covered = new Set<string>();
    for (const questionId of questionIdsByPaper.get(paper.paperId) ?? []) {
      for (const knowledgeId of knowledgeByQuestion.get(questionId) ?? []) covered.add(knowledgeId);
    }
    return { ...paper, knowledgeIds: [...covered] };
  });
}

export async function readPaperSlotCounts(
  db: DbLike,
  paperIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(paperIds)];
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const rows = await db
    .select({ id: artifact.id, tool_state: artifact.tool_state })
    .from(artifact)
    .where(inArray(artifact.id, ids));
  for (const row of rows) counts.set(row.id, countPaperSlots(row.tool_state));
  return counts;
}

export async function attachPaperQuestionCounts<T extends { item_kind: string; ref_id: string }>(
  db: DbLike,
  rows: readonly T[],
): Promise<Array<T & { questionCount?: number }>> {
  const counts = await readPaperSlotCounts(
    db,
    rows.flatMap((row) => (row.item_kind === 'paper' ? [row.ref_id] : [])),
  );
  return rows.map((row) =>
    row.item_kind === 'paper' ? { ...row, questionCount: counts.get(row.ref_id) ?? 0 } : row,
  );
}
