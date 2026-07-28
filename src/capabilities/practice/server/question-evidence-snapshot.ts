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

export class QuestionEvidenceSnapshotError extends Error {
  constructor(
    public readonly code: 'question_not_found' | 'parent_question_not_found' | 'snapshot_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'QuestionEvidenceSnapshotError';
  }
}

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
export async function loadQuestionWithAttemptSnapshot(
  db: DbLike,
  questionId: string,
): Promise<{
  question: QuestionEvidenceSnapshotSource;
  question_snapshot: AttemptQuestionSnapshotT;
}> {
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
    throw new QuestionEvidenceSnapshotError(
      'question_not_found',
      `loadAttemptQuestionSnapshot: question ${questionId} not found`,
    );
  }
  if (row.question.parent_question_id !== null && row.parent_question === null) {
    throw new QuestionEvidenceSnapshotError(
      'parent_question_not_found',
      `loadAttemptQuestionSnapshot: parent question ${row.question.parent_question_id} not found`,
    );
  }
  const parsed = AttemptQuestionSnapshot.safeParse({
    schema_version: 1,
    question: freezeContext(row.question),
    parent_question: row.parent_question ? freezeContext(row.parent_question) : null,
  });
  if (!parsed.success) {
    throw new QuestionEvidenceSnapshotError(
      'snapshot_invalid',
      `loadAttemptQuestionSnapshot: question ${questionId} snapshot is invalid: ${parsed.error.message}`,
    );
  }
  return { question: row.question, question_snapshot: parsed.data };
}

export async function loadAttemptQuestionSnapshot(
  db: DbLike,
  questionId: string,
): Promise<AttemptQuestionSnapshotT> {
  return (await loadQuestionWithAttemptSnapshot(db, questionId)).question_snapshot;
}
