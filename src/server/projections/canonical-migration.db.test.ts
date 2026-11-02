import { beforeEach, describe, expect, it } from 'vitest';
import {
  artifact,
  event,
  goal,
  learning_item,
  materialized_id_index,
  mistake_variant,
  question_block,
} from '@/db/schema';
import { migrateCanonicalProjections } from '../../../scripts/migrate-canonical-projections';
import { resetDb, testDb } from '../../../tests/helpers/db';

const T0 = new Date('2026-06-01T00:00:00.000Z');
const T1 = new Date('2026-06-02T00:00:00.000Z');

async function legacyRows() {
  const db = testDb();
  await db.insert(artifact).values({
    id: 'legacy-note',
    intent_source: 'manual',
    source: 'manual',
    type: 'note_atomic',
    title: '条件概率自解释',
    body_blocks: {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: {
            id: 'reflection',
            semantic_kind: 'check',
            source_markdown: 'P(A|B) 不等于 P(B|A)。'.repeat(30),
          },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '保留条件与反例', marks: [{ type: 'bold' }] }],
            },
          ],
        },
      ],
    },
    version: 3,
    created_at: T0,
    updated_at: T0,
  });
  await db.insert(question_block).values({
    id: 'legacy-block',
    ingestion_session_id: 'legacy-session',
    source_asset_ids: ['legacy-image'],
    page_spans: [],
    figures: [],
    status: 'draft',
    reference_md: '先缩小样本空间，再计算条件概率。',
    version: 2,
    created_at: T0,
    updated_at: T0,
  });
  await db.insert(goal).values({
    id: 'legacy-goal',
    title: '复习条件概率：区分 P(A|B) 与 P(B|A)',
    scope_knowledge_ids: ['conditional', 'independence'],
    sequence_hint: 7,
    source: 'manual',
    status: 'dormant',
    created_at: T0,
    updated_at: T0,
    version: 3,
  });
  await db.insert(mistake_variant).values({
    id: 'legacy-variant',
    parent_question_id: 'ambiguous-parent',
    status: 'broken',
    failure_reasons: ['missing_condition', 'dimension_mismatch'],
    cause_category: 'concept_confusion',
    created_at: T0,
    updated_at: T0,
  });
  await db.insert(learning_item).values([
    {
      id: 'legacy-hub',
      source: 'learning_intent',
      title: '概率与单位检查',
      content: '保留条件、反例与复习记录。'.repeat(80),
      knowledge_ids: ['conditional', 'independence'],
      child_learning_item_ids: ['legacy-child'],
      user_pinned: true,
      ai_score: 0.73,
      due_at: T1,
      reviewed_at: T0,
      created_at: T0,
      updated_at: T0,
      version: 4,
    },
    {
      id: 'legacy-child',
      source: 'learning_intent',
      title: '区分条件变化',
      content: '条件不同，不能直接交换条件概率。',
      knowledge_ids: ['conditional'],
      parent_learning_item_id: 'legacy-hub',
      status: 'done',
      completed_at: T0,
      created_at: T0,
      updated_at: T0,
    },
  ]);
}

async function snapshot() {
  const db = testDb();
  return {
    goals: await db.select().from(goal),
    variants: await db.select().from(mistake_variant),
    items: await db.select().from(learning_item).orderBy(learning_item.id),
    artifacts: await db.select().from(artifact),
    blocks: await db.select().from(question_block),
  };
}

describe('canonical projection deployment migration', () => {
  beforeEach(resetDb);

  it('anchors rich eventless rows atomically without changing live or derived fields; reruns are no-ops', async () => {
    await legacyRows();
    const before = await snapshot();
    expect(await migrateCanonicalProjections(testDb(), T1)).toEqual({
      goal: { seeded: 1, skipped: 0, checked: 1 },
      mistake_variant: { seeded: 1, skipped: 0, checked: 1 },
      learning_item: { seeded: 2, skipped: 0, checked: 2 },
      artifact: { seeded: 1, skipped: 0, checked: 1 },
      question_block: { seeded: 1, skipped: 0, checked: 1 },
      knowledge: { seeded: 0, skipped: 0, checked: 0 },
      knowledge_edge: { seeded: 0, skipped: 0, checked: 0 },
    });
    expect(await snapshot()).toEqual(before);
    const anchors = await testDb().select().from(materialized_id_index);
    expect(anchors).toHaveLength(5);
    const events = await testDb().select().from(event);
    expect(events).toHaveLength(6);
    expect(
      events.every((row) => row.action === 'experimental:genesis' && row.ingest_at !== null),
    ).toBe(true);
    expect(await migrateCanonicalProjections(testDb(), T1)).toEqual({
      goal: { seeded: 0, skipped: 1, checked: 1 },
      mistake_variant: { seeded: 0, skipped: 1, checked: 1 },
      learning_item: { seeded: 0, skipped: 2, checked: 2 },
      artifact: { seeded: 0, skipped: 1, checked: 1 },
      question_block: { seeded: 0, skipped: 1, checked: 1 },
      knowledge: { seeded: 0, skipped: 0, checked: 0 },
      knowledge_edge: { seeded: 0, skipped: 0, checked: 0 },
    });
    expect(await testDb().select().from(event)).toEqual(events);
  });

  it('serializes simultaneous migrations so a legacy row receives exactly one genesis', async () => {
    await legacyRows();
    const results = await Promise.all([
      migrateCanonicalProjections(testDb(), T1),
      migrateCanonicalProjections(testDb(), T1),
    ]);
    expect(results.reduce((sum, result) => sum + result.learning_item.seeded, 0)).toBe(2);
    expect(await testDb().select().from(event)).toHaveLength(6);
    expect(await testDb().select().from(materialized_id_index)).toHaveLength(5);
  });

  // SCF-250 (YUK-1307): a goal whose only goal-subject event is a status/scope ACTION is NOT
  // event-sourced (foldGoal cannot reconstruct a base from it), so the anchor gate now flags it as
  // history-without-a-base-anchor — the operator must repair it rather than have the migration
  // treat it as a reconstructible row.
});
