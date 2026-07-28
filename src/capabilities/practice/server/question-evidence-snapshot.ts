import {
  AttemptQuestionSnapshot,
  type AttemptQuestionSnapshotT,
  type QuestionEvidenceContextSnapshotT,
} from '@/core/schema/question-evidence-snapshot';
import type { Db, Tx } from '@/db/client';
import { question } from '@/db/schema';
import { eq } from 'drizzle-orm';

type DbLike = Db | Tx;
type QuestionEvidenceSnapshotSource = typeof question.$inferSelect;

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
 * learner answer interpretable. Missing parents fail closed.
 */
export async function captureAttemptQuestionSnapshot(
  db: DbLike,
  row: QuestionEvidenceSnapshotSource,
): Promise<AttemptQuestionSnapshotT> {
  let parent: QuestionEvidenceSnapshotSource | null = null;
  if (row.parent_question_id !== null) {
    const [parentRow] = await db
      .select()
      .from(question)
      .where(eq(question.id, row.parent_question_id))
      .limit(1);
    if (!parentRow) {
      throw new Error(
        `captureAttemptQuestionSnapshot: parent question ${row.parent_question_id} not found`,
      );
    }
    parent = parentRow;
  }

  return AttemptQuestionSnapshot.parse({
    schema_version: 1,
    question: freezeContext(row),
    parent_question: parent ? freezeContext(parent) : null,
  });
}

export async function loadAttemptQuestionSnapshot(
  db: DbLike,
  questionId: string,
): Promise<AttemptQuestionSnapshotT> {
  const [row] = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
  if (!row) {
    throw new Error(`loadAttemptQuestionSnapshot: question ${questionId} not found`);
  }
  return captureAttemptQuestionSnapshot(db, row);
}
