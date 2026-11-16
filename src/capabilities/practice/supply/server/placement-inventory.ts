import { type SQL, and, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate, questionSuspendedPredicate } from '@/db/predicates';
import { question } from '@/db/schema';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';

/** A question placement may use: live, unarchived, unexpired, not exposure-blocked,
 * and unrestricted or restricted to include both placement uses. Expiry follows the
 * supply projection (`expires_at`, otherwise `expired_at`): only a parseable timestamp
 * at or before the database clock counts. Serving permission is decided separately
 * by the admission read. */
export function placementUsableQuestionPredicate(): SQL {
  // Present-but-unparseable expires_at must not fall through to expired_at (`??`).
  const expiryCandidate = sql`CASE
    WHEN jsonb_typeof(${question.metadata}->'expires_at') IS NOT NULL
     AND jsonb_typeof(${question.metadata}->'expires_at') IS DISTINCT FROM 'null'
    THEN ${question.metadata}->'expires_at'
    ELSE ${question.metadata}->'expired_at'
  END`;
  return and(
    notDraftPredicate(question.draft_status),
    questionSuspendedPredicate(question),
    isNull(sql`${question.metadata}->>'archived_at'`),
    sql`(${question.metadata}->'exposure_blocked') IS DISTINCT FROM 'true'::jsonb`,
    // AND does not protect a failing cast; CASE does. Unparseable values are not expired.
    sql`NOT (
      SELECT CASE
        WHEN jsonb_typeof(candidate) = 'string'
         AND pg_input_is_valid(candidate #>> '{}', 'timestamptz')
        THEN (candidate #>> '{}')::timestamptz <= clock_timestamp()
        ELSE false
      END
      FROM (SELECT ${expiryCandidate} AS candidate) parsed
    )`,
    sql`(
      jsonb_typeof(${question.metadata}->'allowed_uses') IS DISTINCT FROM 'array'
      OR jsonb_array_length(${question.metadata}->'allowed_uses') = 0
      OR (${question.metadata}->'allowed_uses') ?& array['placement','diagnostic']
    )`,
  ) as SQL;
}

/** Inventory counts serving capability, before information ranking. The background
 * target never delays issuing the first eligible item. */
export async function countPlacementInventory(
  db: Db | Tx,
  knowledgeIds: readonly string[],
): Promise<number> {
  if (knowledgeIds.length === 0) return 0;
  const rows = await db
    .select({ id: question.id })
    .from(question)
    .where(
      and(
        sql`(${sql.join(
          knowledgeIds.map(
            (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
          ),
          sql` OR `,
        )})`,
        placementUsableQuestionPredicate(),
      ),
    );
  return (
    await readAutomaticallyServableQuestionIds(
      db,
      rows.map((row) => row.id),
    )
  ).size;
}
