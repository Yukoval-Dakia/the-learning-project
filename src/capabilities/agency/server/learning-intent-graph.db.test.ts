import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { writeLearningItemProposal } from '@/kernel/proposals/producers';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../../tests/helpers/db';

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
