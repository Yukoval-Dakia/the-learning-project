import { eq } from 'drizzle-orm';
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
import { writeEvent } from '@/kernel/events';
import { migrateCanonicalProjections } from '../../../scripts/migrate-canonical-projections';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { questionBlockLiveRowToSnapshot } from './parity';
import { projectQuestionBlockGuarded } from './question_block';

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

  it('does not confuse a retained unaccepted learning-intent proposal with missing artifact state', async () => {
    await testDb()
      .insert(event)
      .values({
        id: 'unaccepted-intent',
        actor_kind: 'agent',
        actor_ref: 'learning_intent',
        action: 'experimental:propose_learning_intent',
        subject_kind: 'artifact',
        subject_id: 'reserved-not-created',
        outcome: 'success',
        payload: { intent: '比较条件方向，用两个例子解释为何不能交换 P(A|B) 和 P(B|A)' },
        created_at: T0,
        ingest_at: T0,
      });
    const report = await migrateCanonicalProjections(testDb(), T1);
    expect(report.artifact).toEqual({ seeded: 0, skipped: 0, checked: 0 });
    expect(await testDb().select().from(artifact)).toEqual([]);
    expect(await testDb().select().from(event)).toHaveLength(1);
  });

  it.each([true, false])(
    'rejects payload-only secondary history (live=%s) without manufacturing a base',
    async (live) => {
      await legacyRows();
      const [base] = await testDb().select().from(question_block);
      await writeEvent(testDb(), {
        id: 'primary-base',
        actor_kind: 'system',
        actor_ref: 'genesis',
        action: 'experimental:genesis',
        subject_kind: 'question_block',
        subject_id: 'primary-block',
        outcome: 'success',
        payload: {
          row: { ...questionBlockLiveRowToSnapshot(base), id: 'primary-block', version: 0 },
        },
        created_at: T0,
      });
      await writeEvent(testDb(), {
        id: 'secondary-edit',
        actor_kind: 'agent',
        actor_ref: 'old-import',
        action: 'experimental:edit_question_block_structured',
        subject_kind: 'question_block',
        subject_id: 'primary-block',
        outcome: 'success',
        payload: {
          op: 'merge_questions',
          affected_blocks: [
            {
              block_id: 'primary-block',
              role: 'primary',
              structured: {
                id: 'primary-block',
                role: 'standalone',
                prompt_text: '合并后保留条件与子问题',
              },
              version: 1,
              status: 'draft',
            },
            {
              block_id: 'legacy-block',
              role: 'merged_source',
              structured: null,
              version: 2,
              status: 'ignored',
            },
          ],
        },
        created_at: T1,
      });
      await projectQuestionBlockGuarded(testDb(), 'primary-block');
      if (!live) await testDb().delete(question_block).where(eq(question_block.id, 'legacy-block'));
      const before = await snapshot();
      await expect(migrateCanonicalProjections(testDb(), T1)).rejects.toThrow(
        'history without a base anchor',
      );
      expect(await snapshot()).toEqual(before);
      expect((await testDb().select().from(event)).map((row) => row.id).sort()).toEqual([
        'primary-base',
        'secondary-edit',
      ]);
      expect(await testDb().select().from(materialized_id_index)).toEqual([]);
    },
  );

  it.each(['artifact', 'question_block'] as const)(
    'rejects %s live drift without reseeding or rebuilding it',
    async (kind) => {
      await legacyRows();
      await migrateCanonicalProjections(testDb(), T1);
      if (kind === 'artifact')
        await testDb()
          .update(artifact)
          .set({ title: 'out-of-band' })
          .where(eq(artifact.id, 'legacy-note'));
      else
        await testDb()
          .update(question_block)
          .set({ reference_md: 'out-of-band' })
          .where(eq(question_block.id, 'legacy-block'));
      const before = await snapshot();
      const events = await testDb().select().from(event);
      await expect(migrateCanonicalProjections(testDb(), T1)).rejects.toThrow('fold/live drift');
      expect(await snapshot()).toEqual(before);
      expect(await testDb().select().from(event)).toEqual(events);
    },
  );

  it('allows a fresh database without inventing data', async () => {
    const report = await migrateCanonicalProjections(testDb(), T1);
    expect(Object.values(report)).toEqual([
      { seeded: 0, skipped: 0, checked: 0 },
      { seeded: 0, skipped: 0, checked: 0 },
      { seeded: 0, skipped: 0, checked: 0 },
      { seeded: 0, skipped: 0, checked: 0 },
      { seeded: 0, skipped: 0, checked: 0 },
    ]);
    expect(await testDb().select().from(event)).toEqual([]);
  });

  it('fails promptly against an active writer, leaves no partial anchors, and can retry afterward', async () => {
    await legacyRows();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = testDb().transaction(async (tx) => {
      await tx.update(goal).set({ sequence_hint: 8 }).where(eq(goal.id, 'legacy-goal'));
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      await expect(migrateCanonicalProjections(testDb(), T1)).rejects.toMatchObject({
        cause: { code: '55P03' },
      });
      expect(await testDb().select().from(event)).toEqual([]);
      expect(await testDb().select().from(materialized_id_index)).toEqual([]);
    } finally {
      release.resolve();
      await writer;
    }
    expect((await migrateCanonicalProjections(testDb(), T1)).goal.seeded).toBe(1);
  });

  it('anchors rich eventless rows atomically without changing live or derived fields; reruns are no-ops', async () => {
    await legacyRows();
    const before = await snapshot();
    expect(await migrateCanonicalProjections(testDb(), T1)).toEqual({
      goal: { seeded: 1, skipped: 0, checked: 1 },
      mistake_variant: { seeded: 1, skipped: 0, checked: 1 },
      learning_item: { seeded: 2, skipped: 0, checked: 2 },
      artifact: { seeded: 1, skipped: 0, checked: 1 },
      question_block: { seeded: 1, skipped: 0, checked: 1 },
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
    });
    expect(await testDb().select().from(event)).toEqual(events);
  });

  it('does not manufacture a new base over a mutation-only item and rolls back earlier kind anchors', async () => {
    await legacyRows();
    await writeEvent(testDb(), {
      id: 'orphan-completion',
      action: 'experimental:learning_item_complete',
      actor_kind: 'system',
      actor_ref: 'legacy-import',
      subject_kind: 'learning_item',
      subject_id: 'legacy-child',
      outcome: 'success',
      payload: {},
      created_at: T1,
    });
    const before = await snapshot();
    await expect(migrateCanonicalProjections(testDb(), T1)).rejects.toThrow(
      'history without a base anchor',
    );
    expect(await testDb().select().from(materialized_id_index)).toEqual([]);
    expect((await testDb().select().from(event)).map((row) => row.id)).toEqual([
      'orphan-completion',
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects an index anchor with no reconstructible base instead of treating anchor presence as readiness', async () => {
    await legacyRows();
    await testDb().insert(materialized_id_index).values({
      materialized_id: 'legacy-variant',
      anchor_event_id: 'missing-base',
      subject_kind: 'mistake_variant',
    });
    await expect(migrateCanonicalProjections(testDb(), T1)).rejects.toThrow(
      'missing originating event',
    );
    expect(await testDb().select().from(event)).toEqual([]);
    expect(await testDb().select().from(materialized_id_index)).toHaveLength(1);
  });

  it.each(['goal', 'mistake_variant', 'learning_item'] as const)(
    'rejects %s index-only history with a missing originating event',
    async (kind) => {
      await testDb().insert(materialized_id_index).values({
        materialized_id: 'orphan',
        anchor_event_id: 'missing-base',
        subject_kind: kind,
      });
      await expect(migrateCanonicalProjections(testDb(), T1)).rejects.toThrow(
        'missing originating event',
      );
      expect(await testDb().select().from(event)).toEqual([]);
      expect(await testDb().select().from(materialized_id_index)).toHaveLength(1);
    },
  );

  it('does not overwrite an existing base to hide structural drift', async () => {
    await legacyRows();
    await migrateCanonicalProjections(testDb(), T1);
    const events = await testDb().select().from(event);
    await testDb()
      .update(learning_item)
      .set({ title: 'out-of-band corruption' })
      .where(eq(learning_item.id, 'legacy-child'));
    await expect(migrateCanonicalProjections(testDb(), T1)).rejects.toThrow('fold/live drift');
    expect(await testDb().select().from(event)).toEqual(events);
    expect(
      (await testDb().select().from(learning_item).where(eq(learning_item.id, 'legacy-child')))[0]
        .title,
    ).toBe('out-of-band corruption');
  });

  it('rejects an index pointing at a mutation rather than reconstructible originating history', async () => {
    await writeEvent(testDb(), {
      id: 'status-only',
      action: 'experimental:goal_status_update',
      actor_kind: 'system',
      actor_ref: 'legacy-import',
      subject_kind: 'goal',
      subject_id: 'orphan',
      outcome: 'success',
      payload: { status: 'dormant' },
      created_at: T1,
    });
    await testDb().insert(materialized_id_index).values({
      materialized_id: 'orphan',
      anchor_event_id: 'status-only',
      subject_kind: 'goal',
    });
    await expect(migrateCanonicalProjections(testDb(), T1)).rejects.toThrow(
      'unreconstructible originating history',
    );
    expect(await testDb().select().from(materialized_id_index)).toHaveLength(1);
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

  it('rejects an event-only entity that a later projection would resurrect', async () => {
    await legacyRows();
    await migrateCanonicalProjections(testDb(), T1);
    await testDb().delete(learning_item).where(eq(learning_item.id, 'legacy-child'));
    const events = await testDb().select().from(event);
    await expect(migrateCanonicalProjections(testDb(), T1)).rejects.toThrow('legacy-child');
    expect(await testDb().select().from(event)).toEqual(events);
    expect(
      await testDb().select().from(learning_item).where(eq(learning_item.id, 'legacy-child')),
    ).toEqual([]);
  });

  it('rejects a mutation-only goal whose broad anchor predicate cannot reconstruct its base', async () => {
    await legacyRows();
    await writeEvent(testDb(), {
      id: 'orphan-goal-status',
      action: 'experimental:goal_status_update',
      actor_kind: 'system',
      actor_ref: 'legacy-import',
      subject_kind: 'goal',
      subject_id: 'legacy-goal',
      outcome: 'success',
      payload: { status: 'dormant' },
      created_at: T1,
    });
    await expect(migrateCanonicalProjections(testDb(), T1)).rejects.toThrow('fold/live drift');
    expect(await testDb().select().from(materialized_id_index)).toEqual([]);
    expect((await testDb().select().from(event)).map((row) => row.id)).toEqual([
      'orphan-goal-status',
    ]);
  });
});
