import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import type { Tx } from '@/db/client';
import { event, goal, learning_item, mistake_variant } from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { updateGoalStatus } from '@/kernel/records/goal-commands';
import { gatherAndFoldGoal } from '@/server/projections/gather';
import { goalLiveRowToSnapshot } from '@/server/projections/parity';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { acceptAiProposal, retractAiProposal } from './actions';

beforeEach(resetDb);

async function interleaveWithRetract(
  kind: 'goal' | 'mistake_variant' | 'learning_item',
  id: string,
  proposalId: string,
  mutate: (tx: Tx) => Promise<unknown>,
) {
  const db = testDb();
  let acquired!: () => void;
  const locked = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = db.transaction(async (tx) => {
    const table =
      kind === 'goal' ? goal : kind === 'learning_item' ? learning_item : mistake_variant;
    await tx.execute(sql`select id from ${table} where id = ${id} for update`);
    acquired();
    await ready;
    await mutate(tx);
  });
  await locked;
  const retract = retractAiProposal(db, proposalId);
  // Observe an actual blocked database statement, not an assumed sleep duration.
  try {
    await expect
      .poll(
        async () => {
          const rows = await db.execute<{ blocked: boolean }>(sql`
        select exists(select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
          and query ilike '%for update%') as blocked
      `);
          return rows[0].blocked;
        },
        { timeout: 5000, interval: 20 },
      )
      .toBe(true);
  } finally {
    release();
    await writer;
    await retract;
  }
  const corrections = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'correct'), eq(event.caused_by_event_id, proposalId)));
  // A stale first correction must roll back, including its memory outbox intent.
  expect(corrections).toHaveLength(1);
  return corrections[0];
}

it('goal retraction remains last when a status mutation commits while it waits for the row', async () => {
  const db = testDb();
  const proposalId = await writeAiProposal(db, {
    actor_ref: 'goal_scope',
    outcome: 'partial',
    payload: {
      kind: 'goal_scope',
      target: { subject_kind: 'goal', subject_id: 'contended_goal' },
      reason_md: '保留多知识点目标与先后状态',
      evidence_refs: [],
      proposed_change: {
        title: '条件概率与反例',
        subject_id: 'yuwen',
        scope_knowledge_ids: ['kc-a', 'kc-b'],
        sequence_hint: 3,
        reasoning: '同一目标的并发操作',
      },
      cooldown_key: 'goal_scope:contended_goal',
    },
  });
  await acceptAiProposal(db, proposalId);
  const correction = await interleaveWithRetract('goal', 'contended_goal', proposalId, (tx) =>
    updateGoalStatus(tx, 'contended_goal', 'active'),
  );
  const [row] = await db.select().from(goal).where(eq(goal.id, 'contended_goal'));
  expect(row.status).toBe('dormant');
  expect(row.version).toBe(1);
  expect(row.updated_at).toEqual(correction.created_at);
  expect(await gatherAndFoldGoal(db, row.id)).toEqual(goalLiveRowToSnapshot(row));
});
