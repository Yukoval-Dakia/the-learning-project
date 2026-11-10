// 练习流「读取投影」职责模块（自 stream-store.ts 拆出）。
// 持久行 → StreamView，本模块拥有三件事：
// 1. issuance 准入门（filterProspectiveStreamQuestions，含 accepted-answer
// recovery）——读路径与 trim/scoped 物化共用同一份「落库行可否服务」判定；
// 2. 行元数据匹配（resolveStreamItemMetadata：有效判定、knowledge /
// paper 名、answer_recorded）——实现细节不导出，调用方不碰 metadata map；
// 3. 视图装配（buildStreamView / getStreamViewItem）。
// 编排入口（getStream / scoped 物化 / advance / recompose / nightly）留在 stream-store.ts。

import { and, eq, inArray, sql } from 'drizzle-orm';
import { DEFAULT_QUESTION_MINUTES } from '@/core/daily-review-plan';
import type { Db, Tx } from '@/db/client';
import {
  artifact,
  assessment_submission,
  event,
  type practice_stream_item,
  question,
} from '@/db/schema';
import {
  nativeAttemptOutcome,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import {
  readAutomaticIssuanceServingDecisions,
  readAutomaticallyServableQuestionIds,
} from '@/kernel/records/assessment-issuance';
import { countPaperSlots } from '../../session/public';
import { knowledgeLabels } from './knowledge-labels';
import { readQuestionPace } from './question-pace';
import { type DailyPracticePace, estimateStreamItemMinutes } from './stream-budget';

/** 本模块的 DB 句柄：既可是顶层 `db`，也可是事务内 `tx`。 */
type DbLike = Db | Tx;

type StreamItemRow = typeof practice_stream_item.$inferSelect;
type StreamItemStatus = StreamItemRow['status'];

export interface StreamScope {
  kind: 'knowledge';
  id: string;
  label: string;
  /** Server-resolved session identity; null only when viewing an unmaterialized historical scope. */
  session_id: string | null;
}

export interface StreamView {
  date: string;
  scope: StreamScope | null;
  opening_line: string;
  items: Array<{
    id: string;
    position: number;
    item_kind: 'question' | 'paper';
    ref_id: string;
    source: StreamItemRow['source'];
    reasoning: string;
    status: StreamItemStatus;
    estimated_minutes: number;
    knowledge_name: string | null;
    paper_title: string | null;
    /**
     * 今日列表的对/错标签。有效判定映射到既有三档：
     * correct→good（对）、partial→hard（部分对）、incorrect→again（错）。
     * 未判定、自评或不支持为 null。
     */
    verdict: 'again' | 'hard' | 'good' | null;
    /** 有效判定的 coarse verdict；没有有效判定时为 null。 */
    verdict_effective: string | null;
    /** 有效判定仍成立时为 'active'；与 verdict_effective 同生。 */
    verdict_effective_state: string | null;
    completed_at: string | null;
    total_slots: number | null;
    /**
     * an open question whose answer is already recorded (: the attempt is
     * settled, or its background judge is still queued) but whose row is not marked done yet.
     * The same rule the question page uses to make the answer read-only.
     */
    answer_recorded: boolean;
  }>;
  budget: { pace: DailyPracticePace; minutes: number };
  progress: {
    done: number;
    total: number;
    estimated_total_minutes: number;
    estimated_remaining_minutes: number;
  };
}

type StreamViewItem = StreamView['items'][number];

interface StreamItemMetadata {
  knowledgeName: string | null;
  paperTitle: string | null;
  verdict: StreamViewItem['verdict'];
  verdictEffective: string | null;
  verdictEffectiveState: string | null;
  completedAt: string | null;
  totalSlots: number | null;
  answerRecorded: boolean;
}

const EMPTY_STREAM_ITEM_METADATA: StreamItemMetadata = {
  knowledgeName: null,
  paperTitle: null,
  verdict: null,
  verdictEffective: null,
  verdictEffectiveState: null,
  completedAt: null,
  totalSlots: null,
  answerRecorded: false,
};

const STREAM_VERDICT_BY_OUTCOME = {
  success: 'good',
  failure: 'again',
  partial: 'hard',
} as const;

function streamVerdict(
  outcome: ReturnType<typeof nativeAttemptOutcome>,
): StreamViewItem['verdict'] {
  if (outcome === 'success' || outcome === 'failure' || outcome === 'partial')
    return STREAM_VERDICT_BY_OUTCOME[outcome];
  return null;
}

export async function filterProspectiveStreamQuestions(
  db: DbLike,
  rows: StreamItemRow[],
): Promise<{ rows: StreamItemRow[]; recoveryRowIds: Set<string> }> {
  const prospective = rows.filter((row) => row.item_kind === 'question' && row.status !== 'done');
  const issuanceIds = prospective.map((row) => `iss_stream_${row.id}`);
  const issuedDecisions = await readAutomaticIssuanceServingDecisions(db, issuanceIds);
  // An unsupported pinned contract withholds new serving, but it does not erase
  // already-accepted work: when the pinned issuance holds an accepted submission,
  // the stream row is the only path back into Solo for settlement/recovery, so it
  // stays visible (same boundary as getIssuanceState — submissions retain their
  // DTO/history). Unsupported + unanswered rows stay stored yet must never display
  // as a servable question.
  const unsupportedIds = issuanceIds.filter(
    (id) => issuedDecisions.get(id)?.kind === 'unavailable',
  );
  const acceptedIds = new Set<string>();
  if (unsupportedIds.length > 0) {
    const accepted = await db
      .select({ issuance_id: assessment_submission.issuance_id })
      .from(assessment_submission)
      .where(inArray(assessment_submission.issuance_id, unsupportedIds));
    for (const row of accepted) acceptedIds.add(row.issuance_id);
  }
  const admittedIds = await readAutomaticallyServableQuestionIds(
    db,
    prospective.map((row) => row.ref_id),
    { includeInterventionDiagnostics: true },
  );
  const recoveryRowIds = new Set<string>();
  const kept = rows.filter((row) => {
    if (row.item_kind !== 'question' || row.status === 'done') return true;
    const issuanceId = `iss_stream_${row.id}`;
    if (!issuedDecisions.has(issuanceId)) return admittedIds.has(row.ref_id);
    if (issuedDecisions.get(issuanceId)?.kind === 'admitted') return true;
    if (!acceptedIds.has(issuanceId)) return false;
    recoveryRowIds.add(row.id);
    return true;
  });
  return { rows: kept, recoveryRowIds };
}

async function resolveStreamItemMetadata(
  db: DbLike,
  rows: StreamItemRow[],
): Promise<Map<string, StreamItemMetadata>> {
  const metadata = new Map<string, StreamItemMetadata>();
  for (const row of rows) metadata.set(row.id, { ...EMPTY_STREAM_ITEM_METADATA });
  if (rows.length === 0) return metadata;

  const questionRows = rows.filter((row) => row.item_kind === 'question');
  const questionIds = [...new Set(questionRows.map((row) => row.ref_id))];
  if (questionIds.length > 0) {
    const questions = await db
      .select({ id: question.id, knowledge_ids: question.knowledge_ids })
      .from(question)
      .where(inArray(question.id, questionIds));
    const primaryKnowledgeByQuestion = new Map(
      questions.map((row) => [row.id, row.knowledge_ids[0] ?? null]),
    );
    const primaryKnowledgeIds = [
      ...new Set(
        [...primaryKnowledgeByQuestion.values()].filter((id): id is string => id !== null),
      ),
    ];
    const names = await knowledgeLabels(db, primaryKnowledgeIds);
    for (const row of questionRows) {
      const knowledgeId = primaryKnowledgeByQuestion.get(row.ref_id);
      const current = metadata.get(row.id) ?? { ...EMPTY_STREAM_ITEM_METADATA };
      current.knowledgeName = knowledgeId ? (names.get(knowledgeId) ?? null) : null;
      metadata.set(row.id, current);
    }
  }

  const paperRows = rows.filter((row) => row.item_kind === 'paper');
  const paperIds = [...new Set(paperRows.map((row) => row.ref_id))];
  if (paperIds.length > 0) {
    const papers = await db
      .select({ id: artifact.id, title: artifact.title, tool_state: artifact.tool_state })
      .from(artifact)
      .where(inArray(artifact.id, paperIds));
    const paperById = new Map(papers.map((paper) => [paper.id, paper]));
    for (const row of paperRows) {
      const paper = paperById.get(row.ref_id);
      if (!paper) continue;
      const current = metadata.get(row.id) ?? { ...EMPTY_STREAM_ITEM_METADATA };
      current.paperTitle = paper.title;
      current.totalSlots = countPaperSlots(paper.tool_state);
      metadata.set(row.id, current);
    }
  }

  // an in-progress question whose answer is already recorded. Same rule as the
  // question page (, use-practice-submit answerRecorded): this row's issuance has an
  // assessment-attempt anchor whose evaluation is settled (an effective evaluation) or whose
  // judge is still queued (no original evaluation yet). An answer accepted by advice alone, or a
  // review_required attempt still waiting for a self-rating, is not recorded.
  const openQuestions = questionRows.filter((row) => row.status === 'in_progress');
  if (openQuestions.length > 0) {
    const rowByIssuance = new Map(openQuestions.map((row) => [`iss_stream_${row.id}`, row]));
    const anchors = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_attempt'),
          eq(event.subject_kind, 'question'),
          inArray(event.subject_id, [...new Set(openQuestions.map((row) => row.ref_id))]),
          inArray(sql<string>`${event.payload}->>'issuance_id'`, [...rowByIssuance.keys()]),
        ),
      );
    if (anchors.length > 0) {
      const groups = await resolveVerdictsForNativeAttempts(db, anchors);
      for (const anchor of anchors) {
        const group = groups.get(anchor.id);
        if (!group || (group.effective === null && group.original_evaluation_id !== null)) continue;
        const row = rowByIssuance.get(group.issuance.issuance_id);
        if (!row || row.ref_id !== anchor.subject_id) continue;
        const current = metadata.get(row.id) ?? { ...EMPTY_STREAM_ITEM_METADATA };
        current.answerRecorded = true;
        metadata.set(row.id, current);
      }
    }
  }

  const doneQuestions = questionRows.filter((row) => row.status === 'done');
  if (doneQuestions.length > 0) {
    const rowByIssuance = new Map(doneQuestions.map((row) => [`iss_stream_${row.id}`, row]));
    const anchors = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_attempt'),
          eq(event.subject_kind, 'question'),
          inArray(event.subject_id, [...new Set(doneQuestions.map((row) => row.ref_id))]),
          inArray(sql<string>`${event.payload}->>'issuance_id'`, [...rowByIssuance.keys()]),
        ),
      )
      .orderBy(event.created_at, event.id);
    if (anchors.length > 0) {
      const groups = await resolveVerdictsForNativeAttempts(db, anchors);
      for (const anchor of anchors) {
        const group = groups.get(anchor.id);
        const rating = streamVerdict(nativeAttemptOutcome(group));
        if (!group || !rating) continue;
        const row = rowByIssuance.get(group.issuance.issuance_id);
        if (!row || row.ref_id !== anchor.subject_id) continue;
        const current = metadata.get(row.id) ?? { ...EMPTY_STREAM_ITEM_METADATA };
        current.verdict = rating;
        current.verdictEffective = group.effective?.verdict.verdict ?? null;
        current.verdictEffectiveState = group.effective ? 'active' : null;
        current.completedAt = anchor.created_at.toISOString();
        metadata.set(row.id, current);
      }
    }
  }

  return metadata;
}

function toStreamViewItem(
  row: StreamItemRow,
  metadata: StreamItemMetadata,
  questionMinutes: number,
): StreamViewItem {
  return {
    id: row.id,
    position: row.position,
    item_kind: row.item_kind,
    ref_id: row.ref_id,
    source: row.source,
    reasoning: row.reasoning,
    status: row.status,
    estimated_minutes: estimateStreamItemMinutes(row.item_kind, questionMinutes),
    knowledge_name: metadata.knowledgeName,
    paper_title: metadata.paperTitle,
    verdict: metadata.verdict,
    verdict_effective: metadata.verdictEffective,
    verdict_effective_state: metadata.verdictEffectiveState,
    completed_at: metadata.completedAt,
    total_slots: metadata.totalSlots,
    answer_recorded: metadata.answerRecorded,
  };
}

/** Enriched PATCH response item; shares the exact projection used by GET. */
export async function getStreamViewItem(
  db: DbLike,
  row: StreamItemRow,
  questionMinutes?: number,
): Promise<StreamViewItem> {
  const [metadata, pace] = await Promise.all([
    resolveStreamItemMetadata(db, [row]),
    questionMinutes === undefined ? readQuestionPace(db) : null,
  ]);
  return toStreamViewItem(
    row,
    metadata.get(row.id) ?? EMPTY_STREAM_ITEM_METADATA,
    questionMinutes ?? pace?.minutes ?? DEFAULT_QUESTION_MINUTES,
  );
}

async function projectStreamViewItems(
  db: DbLike,
  rows: StreamItemRow[],
  questionMinutes: number,
): Promise<StreamViewItem[]> {
  const metadata = await resolveStreamItemMetadata(db, rows);
  return rows.map((row) =>
    toStreamViewItem(row, metadata.get(row.id) ?? EMPTY_STREAM_ITEM_METADATA, questionMinutes),
  );
}

/**
 * 读投影入口：持久行 → StreamView。元数据匹配在模块内部完成——调用方只交 rows
 * 与装配参数（date/budget/scope/openingLine），不接触 metadata map。
 */
export async function buildStreamView(input: {
  db: DbLike;
  date: string;
  rows: StreamItemRow[];
  budget: { pace: DailyPracticePace; minutes: number };
  scope: StreamScope | null;
  openingLine: string;
  /** measured/default question minutes; omit to read the shared pace. */
  questionMinutes?: number;
}): Promise<StreamView> {
  const { db, date, rows, budget, scope, openingLine } = input;
  const questionMinutes = input.questionMinutes ?? (await readQuestionPace(db)).minutes;
  const done = rows.filter((row) => row.status === 'done').length;
  const estimatedTotalMinutes = rows.reduce(
    (sum, row) => sum + estimateStreamItemMinutes(row.item_kind, questionMinutes),
    0,
  );
  const estimatedRemainingMinutes = rows
    .filter((row) => row.status === 'pending' || row.status === 'in_progress')
    .reduce((sum, row) => sum + estimateStreamItemMinutes(row.item_kind, questionMinutes), 0);
  const items = await projectStreamViewItems(db, rows, questionMinutes);

  return {
    date,
    scope,
    opening_line: openingLine,
    items,
    budget,
    progress: {
      done,
      total: rows.length,
      estimated_total_minutes: estimatedTotalMinutes,
      estimated_remaining_minutes: estimatedRemainingMinutes,
    },
  };
}
