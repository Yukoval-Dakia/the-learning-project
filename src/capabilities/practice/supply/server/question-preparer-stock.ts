import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { question, question_group_lifecycle } from '@/db/schema';
import type { EvidenceDemandV1T } from '@/kernel/supply-contracts';

/** Pending publication reserves supply; it is never reported as usable/admitted stock. */
export async function questionPreparerPendingStock(db: Db, ticket: EvidenceDemandV1T) {
  return db
    .select({
      question_id: question.id,
      prompt_md: question.prompt_md,
      kind: question.kind,
      difficulty: question.difficulty,
      revision_id: question_group_lifecycle.current_revision_id,
    })
    .from(question)
    .innerJoin(question_group_lifecycle, eq(question.id, question_group_lifecycle.group_id))
    .where(
      and(
        isNull(question.parent_question_id),
        eq(question_group_lifecycle.scoring_admission_state, 'withheld'),
        eq(question_group_lifecycle.withdrawn, false),
        eq(question_group_lifecycle.availability, 'general_pool'),
        sql`${question_group_lifecycle.current_revision_id} IS NOT NULL`,
        inArray(question.kind, ticket.task.kinds),
        sql`${question.knowledge_ids} @> ${JSON.stringify(ticket.claim.knowledge_ids)}::jsonb`,
      ),
    );
}
