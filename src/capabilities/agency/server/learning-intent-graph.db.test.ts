import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { artifact, learning_item } from '@/db/schema';
import { writeLearningItemProposal } from '@/kernel/proposals/producers';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runLearningIntentRequest } from './learning-intent-request';

const hub = { title: '总览', summary_md: '概览。' };
const note = (knowledge_id: string) => ({ knowledge_id, title: '条', one_line_intent: '能分辨。' });

function propose(atomics: unknown[], longs: unknown[] = [], existing_items: unknown[] = []) {
  const plan = {
    topic: 'root',
    plan_case: '3c_existing_graph',
    hub,
    atomics,
    longs,
    existing_items,
    mastered_knowledge_ids: [],
    prerequisite_edges: [],
  };
  return writeLearningItemProposal(testDb(), {
    ...plan,
    knowledge_node: { id: 'root', name: 'root' },
    reason_md: '学习路径提议',
    legacy_event_payload: { ...plan, knowledge_node_id: 'root' },
  });
}

// A refused accept may leave no item, no note, and at most a rollback rating.
async function tally(id: string) {
  const [row] = await testDb().execute<{ items: number; notes: number; rating: string | null }>(sql`
    select (select count(*) from learning_item)::int as items, (select count(*) from artifact)::int as notes,
      (select payload->>'rating' from event where action = 'rate' and caused_by_event_id = ${id}) as rating`);
  return row;
}

describe('learning intent reference graph', () => {
  beforeEach(async () => {
    await resetDb();
    await testDb().execute(sql`insert into knowledge (id, name, parent_id, created_at, updated_at)
      values ('root', 'root', null, now(), now()), ('child', 'child', 'root', now(), now())`);
  });

  async function seedExistingItem() {
    await testDb().execute(sql`insert into event (
      id, actor_kind, actor_ref, action, subject_kind, subject_id, outcome, payload,
      caused_by_event_id, created_at, ingest_at
    ) values (
      'reuse-proposal', 'agent', 'learning_intent', 'experimental:propose_learning_intent',
      'artifact', 'reuse-note', 'success', '{\"topic\":\"root\"}', null, now(), now()
    )`);
    await testDb().execute(sql`insert into learning_item (
      id, source, source_ref, title, content, knowledge_ids, primary_artifact_id,
      parent_learning_item_id, status, created_at, updated_at
    ) values (
      'reuse-item', 'learning_intent', 'reuse-proposal', 'reuse item', 'reuse',
      '["child"]'::jsonb, 'reuse-note', null, 'pending', now(), now()
    )`);
    await testDb().execute(sql`insert into artifact (
      id, type, title, knowledge_ids, intent_source, source, source_ref,
      attrs, generation_status, verification_status, history, created_at, updated_at
    ) values (
      'reuse-note', 'note_atomic', 'reuse note', '["child"]'::jsonb, 'learning_intent',
      'ai_generated', 'reuse-proposal', '{}'::jsonb, 'ready', 'not_required', '[]'::jsonb, now(), now()
    )`);
    await testDb().execute(sql`insert into materialized_id_index (
      materialized_id, subject_kind, anchor_event_id
    ) values ('reuse-item', 'learning_item', 'reuse-proposal')`);
    return { itemId: 'reuse-item', noteId: 'reuse-note' };
  }

  // @invariant data: each reuse invalidation is revalidated at accept and falls back to a fresh item/note
  // @fails-if a frozen dead/dismissed/pointer-mismatched reference is still reused or leaves a dead note link
  it.each([
    { name: 'archived note', invalidate: 'archived_note', items: 3, notes: 3 },
    { name: 'archived item', invalidate: 'archived_item', items: 3, notes: 3 },
    { name: 'dismissed item', invalidate: 'dismissed_item', items: 3, notes: 3 },
    { name: 'pointer mismatch', invalidate: 'pointer_mismatch', items: 3, notes: 3 },
    { name: 'source policy denial', invalidate: 'source_policy', items: 3, notes: 3 },
  ])('revalidates reuse reference $name', async ({ invalidate, items, notes }) => {
    const existing = await seedExistingItem();
    if (invalidate === 'archived_note') {
      await testDb()
        .update(artifact)
        .set({ archived_at: new Date() })
        .where(eq(artifact.id, existing.noteId));
    }
    if (invalidate === 'archived_item') {
      await testDb()
        .update(learning_item)
        .set({ archived_at: new Date() })
        .where(eq(learning_item.id, existing.itemId));
    }
    if (invalidate === 'dismissed_item') {
      await testDb()
        .update(learning_item)
        .set({ dismissed_at: new Date() })
        .where(eq(learning_item.id, existing.itemId));
    }
    if (invalidate === 'pointer_mismatch') {
      await testDb()
        .update(learning_item)
        .set({ primary_artifact_id: 'other-note' })
        .where(eq(learning_item.id, existing.itemId));
    }
    if (invalidate === 'source_policy') {
      await testDb().execute(sql`
        update event set payload = jsonb_set(payload, '{derivation_policy}', '"answer_only"')
        where id = 'reuse-proposal'`);
    }
    const id = await propose(
      [note('child')],
      [],
      [
        {
          knowledge_id: 'child',
          item_id: existing.itemId,
          note_id: existing.noteId,
          title: 'reuse item',
        },
      ],
    );
    const accepted = await acceptAiProposal(testDb(), id);
    const materialized = accepted as unknown as {
      atomic_learning_item_ids: string[];
      atomic_artifact_ids: string[];
    };
    expect(materialized.atomic_learning_item_ids).not.toEqual([existing.itemId]);
    expect(materialized.atomic_artifact_ids).not.toEqual([existing.noteId]);
    const result = await tally(id);
    expect(result.items).toBe(items);
    expect(result.notes).toBe(notes);
  });

  // @invariant data: idempotent replay returns the same accept receipt, including action details and created knowledge ids
  // @fails-if replay loses the first action receipt or returns only derived hub rows
  it('replays the complete first-accept materialization receipt', async () => {
    const id = await propose(
      [note('child')],
      [
        {
          knowledge_ids: ['root', 'child'],
          title: '综合',
          one_line_intent: '串联',
        },
      ],
    );
    const first = (await acceptAiProposal(testDb(), id)) as unknown as {
      actions: unknown[];
      created_knowledge_ids: string[];
      atomic_learning_item_ids: string[];
    };
    const second = (await acceptAiProposal(testDb(), id)) as unknown as {
      actions: unknown[];
      created_knowledge_ids: string[];
      atomic_learning_item_ids: string[];
    };
    expect(second).toMatchObject(first);
  });

  // @invariant concurrency: case- and Unicode-equivalent learning-intent requests share one canonical paid-effect identity
  // @fails-if Math/math/Ｍath admit separate paid sends or invoke the provider more than once
  it('replays equivalent requests through one canonical paid-effect identity', async () => {
    await testDb().execute(sql`insert into knowledge (id, name, parent_id, created_at, updated_at)
      values ('math-root', 'Math', null, now(), now()), ('math-child', 'child', 'math-root', now(), now())`);
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        hub: { title: '总览', summary_md: '概览。' },
        atomics: [note('math-child')],
        longs: [],
      }),
    }));
    const first = await runLearningIntentRequest(testDb(), 'Math', runTaskFn);
    const second = await runLearningIntentRequest(testDb(), 'math', runTaskFn);
    const third = await runLearningIntentRequest(testDb(), 'Ｍath', runTaskFn);
    expect(second.proposal_id).toBe(first.proposal_id);
    expect(third.proposal_id).toBe(first.proposal_id);
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const [row] = await testDb().execute<{ entity_id: string; attempts: number }>(sql`
      select entity_id, count(*)::int as attempts from paid_effect
      where family = 'learning_intent_outline' and unit = 'outline'
      group by entity_id`);
    expect(row).toEqual({ entity_id: 'math', attempts: 1 });
  });

  // @invariant data: accept refuses a repeated or outside knowledge id, and an old 3c child that moved, without writing items or notes
  // @fails-if a duplicate/unknown reference or a moved old-3c child still materializes items or notes, or the proposal is marked decided
  it('refuses a broken reference graph and a moved old 3c child without writing', async () => {
    for (const atomics of [
      [note('child'), note('child')],
      [note('child'), note('x')],
    ]) {
      const id = await propose(atomics);
      await expect(acceptAiProposal(testDb(), id)).rejects.toMatchObject({
        code: 'invalid_atomic_knowledge_id',
        status: 422,
      });
      expect(await tally(id)).toEqual({ items: 0, notes: 0, rating: null });
    }
    const id = await propose([note('child')]);
    await testDb().execute(sql`update knowledge set parent_id = null where id = 'child'`);
    await expect(acceptAiProposal(testDb(), id)).rejects.toThrow(/^stale/);
    expect(await tally(id)).toEqual({ items: 0, notes: 0, rating: 'rollback' });
  });

  // @invariant concurrency: an accept waits on the cited knowledge row lock, so an archive committed under that lock re-reads as stale
  // @fails-if accept writes notes without waiting on the row lock, or accepts after the locked child was archived
  it('waits on the knowledge row lock and goes stale when the child is archived', async () => {
    const id = await propose([note('child')]);
    const held = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<void>();
    const holder = testDb().transaction(async (tx) => {
      await tx.execute(sql`select 1 from knowledge where id = 'child' for update`);
      locked.resolve();
      await held.promise;
      await tx.execute(sql`update knowledge set archived_at = now() where id = 'child'`);
    });
    await locked.promise;
    const accepting = acceptAiProposal(testDb(), id);
    const wait = new Promise((resolve) => setTimeout(() => resolve('waiting'), 300));
    expect(await Promise.race([accepting, wait])).toBe('waiting');
    held.resolve();
    await expect(accepting).rejects.toThrow(/^stale/);
    await holder;
    expect(await tally(id)).toEqual({ items: 0, notes: 0, rating: 'rollback' });
  }, 30_000);
});
