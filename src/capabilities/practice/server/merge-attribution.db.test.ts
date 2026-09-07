import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { event, learning_item, question } from '@/db/schema';
import { gatherAndFoldLearningItem } from '@/server/projections/gather';
import { learningItemLiveRowToSnapshot } from '@/server/projections/parity';
import { migrateCanonicalProjections } from '../../../../scripts/migrate-canonical-projections';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { rewriteLearningItemKnowledgeIds, rewriteQuestionKnowledgeIds } from './merge-attribution';

const T0 = new Date('2026-01-01T00:00:00Z');
beforeEach(resetDb);

async function fixture(prepare = true) {
  await testDb()
    .insert(learning_item)
    .values({
      id: 'item',
      source: 'learning_intent',
      title: '条件概率与单位检查',
      content: '保留条件、反例、上下文与复习安排。'.repeat(50),
      knowledge_ids: ['from', 'unrelated', 'middle'],
      child_learning_item_ids: ['child'],
      user_pinned: true,
      status: 'done',
      completed_at: T0,
      version: 7,
      created_at: T0,
      updated_at: T0,
      due_at: T0,
      reviewed_at: T0,
      ai_score: 0.82,
    });
  if (prepare) await migrateCanonicalProjections(testDb(), T0);
  return (await testDb().select().from(learning_item))[0];
}

it('repairs after a newer genesis without an old merge/rate, orders same-clock chains, and preserves all other state', async () => {
  const before = await fixture();
  await testDb().transaction(async (tx) => {
    expect(await rewriteLearningItemKnowledgeIds(tx, 'from', 'middle', T0)).toEqual(['item']);
    expect(await rewriteLearningItemKnowledgeIds(tx, 'middle', 'winner', T0)).toEqual(['item']);
  });
  const [after] = await testDb().select().from(learning_item);
  expect(after).toEqual({ ...before, knowledge_ids: ['winner', 'unrelated'] });
  expect(await gatherAndFoldLearningItem(testDb(), 'item')).toEqual(
    learningItemLiveRowToSnapshot(after),
  );
  const events = await testDb().select().from(event).orderBy(event.created_at);
  expect(events.map((row) => row.action)).toEqual([
    'experimental:genesis',
    'experimental:learning_item_knowledge_ids_rewrite',
    'experimental:learning_item_knowledge_ids_rewrite',
  ]);
  expect(events[1].created_at.getTime()).toBeGreaterThan(events[0].created_at.getTime());
  expect(events[2].created_at.getTime()).toBeGreaterThan(events[1].created_at.getTime());
  expect(events.every((row) => row.ingest_at !== null)).toBe(true);
  await testDb().transaction(async (tx) => {
    expect(await rewriteLearningItemKnowledgeIds(tx, 'from', 'winner', T0)).toEqual([]);
    expect(await rewriteLearningItemKnowledgeIds(tx, 'winner', 'winner', T0)).toEqual([]);
  });
  expect(await testDb().select().from(event).orderBy(event.created_at)).toEqual(events);
});

it('unprepared history rolls back preceding attribution work instead of silently accepting a partial merge', async () => {
  const before = await fixture(false);
  await testDb()
    .insert(question)
    .values({
      id: 'question',
      kind: 'short_answer',
      prompt_md: '比较 P(A|B) 与 P(B|A)',
      reference_md: '条件不同，通常不能互换。',
      knowledge_ids: ['from', 'unrelated'],
      source: 'manual',
      difficulty: 3,
      created_at: T0,
      updated_at: T0,
    });
  await expect(
    testDb().transaction(async (tx) => {
      await rewriteQuestionKnowledgeIds(tx, 'from', 'winner');
      await rewriteLearningItemKnowledgeIds(tx, 'from', 'winner', T0);
    }),
  ).rejects.toThrow('canonical projection migration');
  expect(
    (await testDb().select().from(question).where(eq(question.id, 'question')))[0].knowledge_ids,
  ).toEqual(['from', 'unrelated']);
  expect((await testDb().select().from(learning_item))[0]).toEqual(before);
  expect(await testDb().select().from(event)).toEqual([]);
});
