// YUK-543 — backfill/sweep db tests: chain resolution (spec §4 decision 4b), repair via the shared
// applyMerge helpers, idempotency, and the archived-not-merged-terminal skip.

import { db } from '@/db/client';
import { knowledge, mastery_state, question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import { resolveMergeChains, runMergeAttributionBackfill } from './merge-attribution-backfill';

async function insertK(id: string, opts: { archived?: boolean; mergedFrom?: string[] } = {}) {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: 'wenyan',
    parent_id: null,
    merged_from: opts.mergedFrom ?? [],
    proposed_by_ai: false,
    approval_status: 'approved',
    archived_at: opts.archived ? now : null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}
async function insertQ(id: string, kids: string[]) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: 'p',
    knowledge_ids: kids,
    source: 'test',
    created_at: now,
    updated_at: now,
  });
}

describe('merge-attribution backfill (YUK-543)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('resolveMergeChains: single hop resolves to the live winner', async () => {
    await insertK('k_into', { mergedFrom: ['k_from'] });
    await insertK('k_from', { archived: true });
    const res = await resolveMergeChains(db);
    expect(res).toEqual([{ fromId: 'k_from', winnerId: 'k_into' }]);
  });

  it('repairs a pre-fix orphan (question + mastery) and is idempotent', async () => {
    await insertK('k_into', { mergedFrom: ['k_from'] });
    await insertK('k_from', { archived: true });
    await insertQ('q1', ['k_from', 'k_x']);
    await db.insert(mastery_state).values({ id: 'ms1', subject_id: 'k_from' });

    const first = await runMergeAttributionBackfill(db, { dryRun: false });
    expect(first.resolved).toBe(1);
    expect(first.orphanSurfacesFound).toBeGreaterThanOrEqual(2); // question + mastery

    const q1 = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(q1[0].knowledge_ids).toEqual(['k_into', 'k_x']);
    const msInto = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'k_into'));
    expect(msInto).toHaveLength(1);

    // second run = no-op (nothing still references k_from).
    const second = await runMergeAttributionBackfill(db, { dryRun: false });
    expect(second.orphanSurfacesFound).toBe(0);
  });

  it('resolves a 2-hop chain to the terminal live winner (A→B→C ⇒ C)', async () => {
    await insertK('k_c', { mergedFrom: ['k_b'] }); // live winner
    await insertK('k_b', { archived: true, mergedFrom: ['k_a'] });
    await insertK('k_a', { archived: true });
    await insertQ('q1', ['k_a']);

    const res = await runMergeAttributionBackfill(db, { dryRun: false });
    expect(res.resolved).toBe(2); // both k_a and k_b resolve to k_c
    expect(res.winners).toBe(1);
    const q1 = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(q1[0].knowledge_ids).toEqual(['k_c']);
  });

  it('skips an archived-not-merged terminal (does not guess), leaving the surface stale', async () => {
    await insertK('k_x', { archived: true, mergedFrom: ['k_from'] }); // terminal is archived, NOT merged
    await insertK('k_from', { archived: true });
    await insertQ('q1', ['k_from']);

    const res = await runMergeAttributionBackfill(db, { dryRun: false });
    expect(res.skipped).toBe(1);
    expect(res.resolved).toBe(0);
    const q1 = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(q1[0].knowledge_ids).toEqual(['k_from']); // untouched (not guessed)
  });

  it('dry-run census finds orphan surfaces but writes nothing', async () => {
    await insertK('k_into', { mergedFrom: ['k_from'] });
    await insertK('k_from', { archived: true });
    await insertQ('q1', ['k_from']);

    const res = await runMergeAttributionBackfill(db, { dryRun: true });
    expect(res.orphanSurfacesFound).toBeGreaterThanOrEqual(1);
    // zero writes: the question still references k_from.
    const q1 = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(q1[0].knowledge_ids).toEqual(['k_from']);
  });
});
