// Revert state is derived, never stored on the block row. Two existing records define it:
// the enrollment lifecycle transition and the retract correction the revert owner writes.
// Only those two classes matter — a later figure reassignment or status edit must not
// erase a revert. The read projection and the automatic selector share this criterion.

import { sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';

/**
 * Block ids whose last retract is at or after their last enrollment transition. A later
 * manual enrollment writes a newer auto_enrolled lifecycle row and leaves the set; a
 * same-millisecond tie is treated as reverted because the block is still draft when this
 * query runs (a successful enrollment would have moved it out of draft).
 */
export async function readRevertedBlockIds(
  db: Db | Tx,
  blockIds: readonly string[],
): Promise<Set<string>> {
  if (blockIds.length === 0) return new Set();
  const ids = sql.join(
    blockIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<{ block_id: string }>(sql`
    with latest_enroll as (
      select subject_id as block_id, max(created_at) as at
      from event
      where action = 'experimental:question_block_lifecycle'
        and subject_kind = 'question_block'
        and payload->>'op' = 'set_status'
        and payload->>'status' in ('auto_enrolled', 'imported', 'submitted')
        and subject_id in (${ids})
      group by subject_id
    ),
    latest_revert as (
      select coalesce(q.metadata->>'question_block_id', e.payload->>'question_block_id')
               as block_id,
             max(e.created_at) as at
      from event e
      left join question q
        on q.id = e.payload->'affected_refs'->0->>'id'
      where e.action = 'correct'
        and e.payload->>'correction_kind' = 'retract'
      group by 1
    )
    select r.block_id
    from latest_revert r
    left join latest_enroll e on e.block_id = r.block_id
    where r.block_id in (${ids})
      and r.at is not null
      and (e.at is null or r.at >= e.at)
  `);
  return new Set(rows.map((row) => row.block_id));
}
