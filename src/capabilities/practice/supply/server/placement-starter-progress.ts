import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { readQuestionServing } from '@/kernel/read-models/question-serving';

/** Delivery completion is evidence that waiting cannot advance this candidate. It
 * never grants serving permission or authorizes another send of the same paid input. */
export async function readPlacementCandidateProgress(db: Db | Tx, questionIds: string[]) {
  if (questionIds.length === 0) return [];
  const serving = (await readQuestionServing(db, questionIds)).byId;
  const facts = await db.execute<{ id: string; stopped: boolean }>(sql`
    select q.id, (
      exists (
        select 1 from paid_effect p
        where p.family = 'question_admission_run'
          and p.entity_id = coalesce(q.parent_question_id, q.id)
          and p.entity_revision = r.integrity_digest and p.state = 'unknown'
      ) or (
        exists (
          select 1 from pgboss.job j
          where j.name = 'question_admission_run'
            and j.data->>'question_id' = coalesce(q.parent_question_id, q.id)
            and j.data->>'expected_revision_digest' = r.integrity_digest
            and j.data->>'expected_admission_generation' = l.scoring_admission_generation::text
            and j.state in ('completed', 'failed', 'cancelled')
        ) and not exists (
          select 1 from pgboss.job j
          where j.name in ('question_admission_run', 'source_verify')
            and (j.data->>'question_id' = coalesce(q.parent_question_id, q.id)
              or (j.data->'question_ids') ? coalesce(q.parent_question_id, q.id))
            and j.state in ('created', 'retry', 'active')
        )
      )
    ) as stopped
    from question q
    left join question_group_lifecycle l on l.group_id = coalesce(q.parent_question_id, q.id)
    left join question_revision r on r.revision_id = l.current_revision_id
    where q.id in (${sql.join(
      questionIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
  const stopped = new Set(facts.filter((row) => row.stopped).map((row) => row.id));
  return questionIds.map((questionId) => {
    const item = serving.get(questionId);
    const terminalHold = item?.hold_reason != null && item.hold_reason !== 'awaiting_admission';
    return {
      question_id: questionId,
      state: item?.servable
        ? ('available' as const)
        : terminalHold || stopped.has(questionId)
          ? ('unavailable' as const)
          : ('pending' as const),
      reason: item?.servable ? null : (item?.hold_reason ?? null),
    };
  });
}
