import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { question, question_group_lifecycle, question_revision } from '@/db/schema';
import type { IngestionAssessmentReceipt } from '../api/contracts';
import { ingestionCaptureIdentity } from './capture-identity';

type BlockReference = {
  id: string;
  ingestion_session_id: string;
  version: number;
  imported_question_id: string | null;
};

/** Reads committed capture/publication facts; never verifies, publishes or retries. */
export async function readIngestionAssessmentReceipts(
  db: Db | Tx,
  blocks: BlockReference[],
): Promise<Map<string, IngestionAssessmentReceipt>> {
  const result = new Map<string, IngestionAssessmentReceipt>();
  if (blocks.length === 0) return result;
  const ids = new Map(
    blocks.map((block) => [
      block.id,
      block.imported_question_id ?? ingestionCaptureIdentity(block).questionId,
    ]),
  );
  const rows = await db
    .select({
      id: question.id,
      lifecycle: question_group_lifecycle,
      revision: question_revision.revision_id,
    })
    .from(question)
    .leftJoin(
      question_group_lifecycle,
      eq(
        question_group_lifecycle.group_id,
        sql`coalesce(${question.parent_question_id}, ${question.id})`,
      ),
    )
    .leftJoin(
      question_revision,
      and(
        eq(question_revision.group_id, question_group_lifecycle.group_id),
        eq(question_revision.revision_id, question_group_lifecycle.current_revision_id),
      ),
    )
    .where(inArray(question.id, [...ids.values()]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const block of blocks) {
    const questionId = block.imported_question_id ?? ingestionCaptureIdentity(block).questionId;
    const row = byId.get(questionId);
    if (!row) {
      result.set(
        block.id,
        block.imported_question_id
          ? { status: 'unknown', question_id: questionId, reason: 'linked_question_missing' }
          : { status: 'not_created' },
      );
      continue;
    }
    const state = row.lifecycle;
    if (!state || !row.revision) {
      result.set(block.id, {
        status: 'unknown',
        question_id: questionId,
        reason: 'publication_missing',
      });
      continue;
    }
    result.set(block.id, {
      status: 'saved',
      question_id: questionId,
      group_id: state.group_id,
      revision_id: row.revision,
      availability: state.availability,
      admission: {
        state: state.scoring_admission_state,
        reason: state.scoring_admission_withheld_reason,
        generation: state.scoring_admission_generation,
      },
      suspended: state.suspended,
      withdrawn: state.withdrawn,
    });
  }
  return result;
}
