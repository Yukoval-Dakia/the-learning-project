import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { updateGoalStatus } from '@/capabilities/agency/server/goals/queries';
import type { Tx } from '@/db/client';
import { event, goal, learning_item, mistake_variant, question } from '@/db/schema';
import {
  writeLearningItemProposal,
  writeVariantQuestionProposal,
} from '@/kernel/proposals/producers';
import { writeAiProposal } from '@/kernel/proposals/writer';
import {
  gatherAndFoldGoal,
  gatherAndFoldLearningItem,
  gatherAndFoldMistakeVariant,
} from '@/server/projections/gather';
import {
  goalLiveRowToSnapshot,
  learningItemLiveRowToSnapshot,
  mistakeVariantLiveRowToSnapshot,
} from '@/server/projections/parity';
import { migrateCanonicalProjections } from '../../../scripts/migrate-canonical-projections';
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

it('variant retraction stays dismissed when acceptance commits while it waits for the row', async () => {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: 'parent',
    kind: 'short_answer',
    prompt_md: '比较两个条件概率，并解释反例。',
    reference_md: '条件不同，通常不能互换。',
    knowledge_ids: ['kc-a', 'kc-b'],
    difficulty: 3,
    source: 'manual',
    created_at: now,
    updated_at: now,
  });
  const proposalId = await writeVariantQuestionProposal(db, {
    source_question_id: 'parent',
    source_attempt_event_id: 'attempt',
    prompt_md: '给出 P(A|B) 与 P(B|A) 不相等的数值例子。',
    reference_md: '用样本空间计算分母的差异。',
    difficulty: 3,
    knowledge_ids: ['kc-a', 'kc-b'],
    parent_variant_id: 'parent',
    root_question_id: 'parent',
    variant_depth: 1,
    reason_md: '针对概念混淆生成变式',
  });
  await db.insert(mistake_variant).values({
    id: 'contended_variant',
    parent_question_id: 'parent',
    proposal_event_id: proposalId,
    status: 'draft',
    failure_reasons: [],
    cause_category: 'concept',
    created_at: now,
    updated_at: now,
  });
  await migrateCanonicalProjections(db);
  const enqueue = vi.fn(async () => {});
  const correction = await interleaveWithRetract(
    'mistake_variant',
    'contended_variant',
    proposalId,
    (tx) => acceptAiProposal(tx as never, proposalId, { enqueueVariantVerify: enqueue }),
  );
  const [row] = await db
    .select()
    .from(mistake_variant)
    .where(eq(mistake_variant.id, 'contended_variant'));
  expect(row.status).toBe('dismissed');
  expect(row.variant_question_id).toBeTruthy();
  expect(row.updated_at).toEqual(correction.created_at);
  expect(await gatherAndFoldMistakeVariant(db, row.id)).toEqual(
    mistakeVariantLiveRowToSnapshot(row),
  );
  expect(enqueue).toHaveBeenCalledOnce();
});

it('item archive retains completion committed while proposal retraction waits for the row', async () => {
  const db = testDb();
  const proposalId = await writeLearningItemProposal(db, {
    topic: '条件概率',
    knowledge_node: { id: 'kc-a', name: '条件概率', domain: 'yuwen' },
    hub: { title: '概率与反例', summary_md: '保留原学习状态与完成证据。'.repeat(20) },
    atomics: [],
    reason_md: '组合学习项撤销',
    evidence_refs: [],
  });
  const now = new Date();
  await db.insert(learning_item).values({
    id: 'contended_item',
    source: 'learning_intent',
    source_ref: proposalId,
    title: '概率与反例',
    content: '完整上下文与例子。'.repeat(30),
    knowledge_ids: ['kc-a', 'kc-b'],
    status: 'pending',
    created_at: now,
    updated_at: now,
  });
  await migrateCanonicalProjections(db);
  const completionId = await writeAiProposal(db, {
    payload: {
      kind: 'completion',
      target: { subject_kind: 'learning_item', subject_id: 'contended_item' },
      reason_md: '复核掌握',
      evidence_refs: [],
      proposed_change: {
        learning_item_id: 'contended_item',
        triggering_signals: ['check_all_passed'],
        evidence_json: { rationale: '可解释条件差异及反例' },
      },
      cooldown_key: 'completion:contended_item',
    },
  });
  const correction = await interleaveWithRetract(
    'learning_item',
    'contended_item',
    proposalId,
    (tx) => acceptAiProposal(tx as never, completionId),
  );
  const [row] = await db.select().from(learning_item).where(eq(learning_item.id, 'contended_item'));
  expect(row).toMatchObject({ status: 'done', version: 1, archived_reason: 'proposal_retracted' });
  expect(row.completed_at).toBeInstanceOf(Date);
  expect(row.archived_at).toEqual(correction.created_at);
  expect(row.updated_at).toEqual(correction.created_at);
  expect(await gatherAndFoldLearningItem(db, row.id)).toEqual(learningItemLiveRowToSnapshot(row));
});
