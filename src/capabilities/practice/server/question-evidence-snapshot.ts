import {
  AttemptQuestionSnapshot,
  type AttemptQuestionSnapshotT,
  type QuestionEvidenceContextSnapshotT,
} from '@/core/schema/question-evidence-snapshot';
import type { Db, Tx } from '@/db/client';
import { question } from '@/db/schema';
import { eq, getTableColumns } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

type DbLike = Db | Tx;
type QuestionEvidenceSnapshotSource = typeof question.$inferSelect;
const parentQuestion = alias(question, 'attempt_question_evidence_parent');

function freezeContext(row: QuestionEvidenceSnapshotSource): QuestionEvidenceContextSnapshotT {
  return {
    question_id: row.id,
    question_version: row.version,
    parent_question_id: row.parent_question_id,
    prompt_md: row.prompt_md,
    reference_md: row.reference_md,
    choices_md: row.choices_md,
    image_refs: row.image_refs,
    figures: row.figures,
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Freeze the exact child + shared parent context that makes one historical
 * learner answer interpretable. One joined statement prevents a concurrent
 * edit from producing a child/parent snapshot assembled from different reads.
 * Missing parents fail closed.
 */
export async function loadAttemptQuestionSnapshot(
  db: DbLike,
  questionId: string,
): Promise<AttemptQuestionSnapshotT> {
  const [row] = await db
    .select({
      question: getTableColumns(question),
      parent_question: getTableColumns(parentQuestion),
    })
    .from(question)
    .leftJoin(parentQuestion, eq(question.parent_question_id, parentQuestion.id))
    .where(eq(question.id, questionId))
    .limit(1);
  if (!row) {
    throw new Error(`loadAttemptQuestionSnapshot: question ${questionId} not found`);
  }
  if (row.question.parent_question_id !== null && row.parent_question === null) {
    throw new Error(
      `loadAttemptQuestionSnapshot: parent question ${row.question.parent_question_id} not found`,
    );
  }
  return AttemptQuestionSnapshot.parse({
    schema_version: 1,
    question: freezeContext(row.question),
    parent_question: row.parent_question ? freezeContext(row.parent_question) : null,
  });
}
