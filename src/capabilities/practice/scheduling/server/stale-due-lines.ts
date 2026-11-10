// Pending decay rows are a snapshot of a card that was due when the stream was
// composed. A later read or rerank drops a row whose card is no longer due today,
// or whose knowledge was settled after the row was written. Remaining due rows
// stay where they are.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { learnerLocalDay } from '@/core/learner-day';
import type { Db, Tx } from '@/db/client';
import { event, material_fsrs_state, practice_stream_item, question } from '@/db/schema';
import { lockPracticeStreamPartition } from '@/kernel/locks/practice-stream';

type DbLike = Db | Tx;

const SETTLED_REVIEW_ACTIONS = new Set(['review', 'experimental:assessment_settlement']);

type CardKind = 'knowledge' | 'question';

type CardRef = { kind: CardKind; id: string };

type CardClock = {
  dueAt: Date;
  settledReviewAt: Date | null;
};

type PendingDueLine = {
  rowId: string;
  createdAt: Date;
  cards: CardRef[];
};

function cardKey(card: CardRef): string {
  return `${card.kind}:${card.id}`;
}

function streamPartitionPredicate(date: string, sessionId?: string | null) {
  return sessionId
    ? and(eq(practice_stream_item.date, date), eq(practice_stream_item.session_id, sessionId))
    : and(eq(practice_stream_item.date, date), isNull(practice_stream_item.session_id));
}

/** A line stays only while one of its cards is still an open due obligation. */
function dueLineShouldWithdraw(
  line: PendingDueLine,
  clocks: ReadonlyMap<string, CardClock>,
  streamDay: string,
): boolean {
  if (line.cards.length === 0) return true;
  return line.cards.every((card) => {
    const clock = clocks.get(cardKey(card));
    if (!clock) return true;
    if (learnerLocalDay(clock.dueAt) > streamDay) return true;
    return clock.settledReviewAt !== null && clock.settledReviewAt > line.createdAt;
  });
}

function cardsForQuestion(
  questionId: string,
  knowledgeIds: readonly string[],
  present: ReadonlySet<string>,
): CardRef[] {
  if (knowledgeIds.length > 0) {
    return knowledgeIds
      .filter((id) => present.has(cardKey({ kind: 'knowledge', id })))
      .map((id) => ({ kind: 'knowledge' as const, id }));
  }
  const questionCard: CardRef = { kind: 'question', id: questionId };
  return present.has(cardKey(questionCard)) ? [questionCard] : [];
}

async function withdrawInTransaction(
  tx: Tx,
  date: string,
  sessionId?: string | null,
): Promise<number> {
  await lockPracticeStreamPartition(tx, date, sessionId);
  const rows = await tx
    .select()
    .from(practice_stream_item)
    .where(streamPartitionPredicate(date, sessionId));
  const pending = rows.filter(
    (row) => row.status === 'pending' && row.item_kind === 'question' && row.source === 'decay',
  );
  if (pending.length === 0) return 0;

  const questionIds = [...new Set(pending.map((row) => row.ref_id))];
  const questions = await tx
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(inArray(question.id, questionIds));
  const knowledgeIdsByQuestion = new Map(questions.map((row) => [row.id, row.knowledge_ids ?? []]));
  const knowledgeIds = [...new Set([...knowledgeIdsByQuestion.values()].flat())];
  const unlabeledQuestionIds = questionIds.filter(
    (id) => (knowledgeIdsByQuestion.get(id) ?? []).length === 0,
  );

  const clocks = new Map<string, CardClock>();
  const knowledgeClause =
    knowledgeIds.length > 0
      ? and(
          eq(material_fsrs_state.subject_kind, 'knowledge'),
          inArray(material_fsrs_state.subject_id, knowledgeIds),
        )
      : undefined;
  const questionClause =
    unlabeledQuestionIds.length > 0
      ? and(
          eq(material_fsrs_state.subject_kind, 'question'),
          inArray(material_fsrs_state.subject_id, unlabeledQuestionIds),
        )
      : undefined;
  const subjectClause =
    knowledgeClause && questionClause
      ? or(knowledgeClause, questionClause)
      : (knowledgeClause ?? questionClause);
  if (subjectClause) {
    const states = await tx
      .select({
        subject_kind: material_fsrs_state.subject_kind,
        subject_id: material_fsrs_state.subject_id,
        due_at: material_fsrs_state.due_at,
        last_review_event_id: material_fsrs_state.last_review_event_id,
      })
      .from(material_fsrs_state)
      .where(subjectClause);
    const reviewIds = [
      ...new Set(
        states.flatMap((state) => (state.last_review_event_id ? [state.last_review_event_id] : [])),
      ),
    ];
    const reviews =
      reviewIds.length === 0
        ? []
        : await tx
            .select({
              id: event.id,
              action: event.action,
              created_at: event.created_at,
            })
            .from(event)
            .where(inArray(event.id, reviewIds));
    const reviewById = new Map(reviews.map((row) => [row.id, row]));
    for (const state of states) {
      const kind: CardKind = state.subject_kind === 'knowledge' ? 'knowledge' : 'question';
      const review = state.last_review_event_id
        ? reviewById.get(state.last_review_event_id)
        : undefined;
      clocks.set(cardKey({ kind, id: state.subject_id }), {
        dueAt: state.due_at,
        settledReviewAt:
          review && SETTLED_REVIEW_ACTIONS.has(review.action) ? review.created_at : null,
      });
    }
  }

  const present = new Set(clocks.keys());
  const deleteIds = pending
    .filter((row) => {
      const labels = knowledgeIdsByQuestion.get(row.ref_id);
      const cards = labels === undefined ? [] : cardsForQuestion(row.ref_id, labels, present);
      return dueLineShouldWithdraw(
        { rowId: row.id, createdAt: row.created_at, cards },
        clocks,
        date,
      );
    })
    .map((row) => row.id);
  if (deleteIds.length === 0) return 0;
  await tx
    .delete(practice_stream_item)
    .where(
      and(streamPartitionPredicate(date, sessionId), inArray(practice_stream_item.id, deleteIds)),
    );
  return deleteIds.length;
}

export async function withdrawStalePendingDueLines(
  db: DbLike,
  date: string,
  sessionId?: string | null,
): Promise<number> {
  if ('$client' in db) return db.transaction((tx) => withdrawInTransaction(tx, date, sessionId));
  return withdrawInTransaction(db, date, sessionId);
}
