// Revert state is derived, never stored on the block row. The revert owner restores the
// block with a `set_status` lifecycle event ending in draft + cleared import links; that
// latest lifecycle record is the same criterion the read projection and the automatic
// selector use, so no new column and no second truth source.

import { sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';

/**
 * Block ids whose latest lifecycle transition is the revert restore (draft with both
 * import links explicitly cleared). A later manual enrollment writes a newer
 * auto_enrolled lifecycle row, so the block leaves this set naturally.
 */
export async function readRevertedBlockIds(
  db: Db | Tx,
  blockIds: readonly string[],
): Promise<Set<string>> {
  if (blockIds.length === 0) return new Set();
  const rows = await db.execute<{ subject_id: string }>(sql`
    select latest.subject_id
    from (
      select subject_id, payload,
        row_number() over (
          partition by subject_id
          order by created_at desc, id desc
        ) as rn
      from ${sql.identifier('event')}
      where action = 'experimental:question_block_lifecycle'
        and subject_kind = 'question_block'
        and subject_id in (${sql.join(
          blockIds.map((id) => sql`${id}`),
          sql`, `,
        )})
    ) latest
    where latest.rn = 1
      and latest.payload->>'op' = 'set_status'
      and latest.payload->>'status' = 'draft'
      and latest.payload ? 'imported_question_id'
      and latest.payload->'imported_question_id' = 'null'::jsonb
      and latest.payload ? 'imported_attempt_event_id'
      and latest.payload->'imported_attempt_event_id' = 'null'::jsonb
  `);
  return new Set(rows.map((row) => row.subject_id));
}
