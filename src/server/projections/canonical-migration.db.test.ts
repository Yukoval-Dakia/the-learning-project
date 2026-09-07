import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, goal, learning_item, materialized_id_index, mistake_variant } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { migrateCanonicalProjections } from '../../../scripts/migrate-canonical-projections';
import { resetDb, testDb } from '../../../tests/helpers/db';

const T0 = new Date('2026-06-01T00:00:00.000Z');
const T1 = new Date('2026-06-02T00:00:00.000Z');

async function legacyRows() {
  const db = testDb();
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
  };
}

describe('canonical projection deployment migration', () => {
  beforeEach(resetDb);

  it('allows a fresh database without inventing data', async () => {
    const report = await migrateCanonicalProjections(testDb(), T1);
    expect(Object.values(report)).toEqual([
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
    });
    expect(await snapshot()).toEqual(before);
    const anchors = await testDb().select().from(materialized_id_index);
    expect(anchors).toHaveLength(4);
    const events = await testDb().select().from(event);
    expect(events).toHaveLength(4);
    expect(
      events.every((row) => row.action === 'experimental:genesis' && row.ingest_at !== null),
    ).toBe(true);
    expect(await migrateCanonicalProjections(testDb(), T1)).toEqual({
      goal: { seeded: 0, skipped: 1, checked: 1 },
      mistake_variant: { seeded: 0, skipped: 1, checked: 1 },
      learning_item: { seeded: 0, skipped: 2, checked: 2 },
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
    expect(await testDb().select().from(event)).toHaveLength(4);
    expect(await testDb().select().from(materialized_id_index)).toHaveLength(4);
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
