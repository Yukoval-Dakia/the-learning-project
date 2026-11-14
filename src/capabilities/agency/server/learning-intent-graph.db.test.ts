import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { artifact } from '@/db/schema';
import { writeLearningItemProposal } from '@/kernel/proposals/producers';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runLearningIntentRequest } from './learning-intent-request';

const hub = { title: '总览', summary_md: '概览。' };
const note = (knowledge_id: string) => ({ knowledge_id, title: '条', one_line_intent: '能分辨。' });

// Old 3c proposal: no reviewed ids, so accept derives the legal child set under its lock.
function propose(atomics: unknown[]) {
  const plan = { topic: 'root', plan_case: '3c_existing_graph', hub, atomics };
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

  // @invariant data: an existing learning item reference is reused only while both item and note remain live
  // @fails-if archiving the referenced note after proposal creation leaves accept pointing at the dead note instead of creating a fresh one
  it('revalidates reuse references inside accept and creates a replacement note when the source dies', async () => {
    const existing = await seedExistingItem();
    await testDb()
      .update(artifact)
      .set({ archived_at: new Date() })
      .where(eq(artifact.id, existing.noteId));
    const id = await propose([note('child')]);
    const accepted = await acceptAiProposal(testDb(), id);
    const materialized = accepted as unknown as {
      atomic_learning_item_ids: string[];
      atomic_artifact_ids: string[];
    };
    expect(materialized.atomic_learning_item_ids).not.toEqual([existing.itemId]);
    expect(materialized.atomic_artifact_ids).not.toEqual([existing.noteId]);
    expect(accepted.actions).toContainEqual(
      expect.objectContaining({
        kind: 'atomic',
        action: 'create',
        learning_item_id: materialized.atomic_learning_item_ids[0],
        note_id: materialized.atomic_artifact_ids[0],
      }),
    );
    const result = await tally(id);
    expect(result.items).toBe(3);
    expect(result.notes).toBe(3);
  });

  // @invariant concurrency: case-equivalent learning-intent requests share one canonical paid-effect identity
  // @fails-if Math/math admit separate paid sends or invoke the provider twice instead of replaying one proposal
  it('replays case-equivalent requests through one canonical paid-effect identity', async () => {
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
    expect(second.proposal_id).toBe(first.proposal_id);
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
