import { db } from '@/db/client';
import { question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../tests/helpers/db';
import { poolFetch } from './pool-fetch';

// 1024-dim vector (matches EMBED_DIMS) with the first two components set.
function vec(a: number, b: number): number[] {
  const v = new Array(1024).fill(0);
  v[0] = a;
  v[1] = b;
  return v;
}

type QF = Partial<typeof question.$inferInsert> & { id: string };
async function seed(f: QF) {
  await db.insert(question).values({
    kind: 'short_answer',
    prompt_md: 'P',
    source: 'authentic',
    created_at: new Date(),
    updated_at: new Date(),
    draft_status: null,
    ...f,
  });
}

describe('poolFetch', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('filters by KC containment + active + difficulty floor', async () => {
    const kc = 'kc-1';
    await seed({ id: 'q-lo', knowledge_ids: [kc], difficulty: 2 });
    await seed({ id: 'q-hi', knowledge_ids: [kc], difficulty: 4 });
    await seed({ id: 'q-draft', knowledge_ids: [kc], difficulty: 5, draft_status: 'draft' });
    await seed({ id: 'q-other', knowledge_ids: ['kc-2'], difficulty: 4 });
    const rows = await poolFetch(db, { knowledgeId: kc, difficultyMin: 3 });
    expect(rows.map((r) => r.id)).toEqual(['q-hi']);
  });

  it('compositeParentOnly returns only parents that have a child part', async () => {
    const kc = 'kc-c';
    await seed({ id: 'parent', knowledge_ids: [kc] });
    await seed({
      id: 'child',
      knowledge_ids: [kc],
      parent_question_id: 'parent',
      kind: 'question_part',
    });
    await seed({ id: 'standalone', knowledge_ids: [kc] });
    const rows = await poolFetch(db, { knowledgeId: kc, compositeParentOnly: true });
    expect(rows.map((r) => r.id)).toEqual(['parent']);
  });

  it('orders by cosine distance when queryEmbedding given (hybrid)', async () => {
    const kc = 'kc-vec';
    await seed({ id: 'q-a', knowledge_ids: [kc], embedding: vec(1, 0) });
    await seed({ id: 'q-b', knowledge_ids: [kc], embedding: vec(0, 1) });
    const rows = await poolFetch(db, { knowledgeId: kc, queryEmbedding: vec(0.9, 0.1) });
    expect(rows[0].id).toBe('q-a'); // nearest
    expect(rows.map((r) => r.id).sort()).toEqual(['q-a', 'q-b']);
  });

  it('excludes NULL-embedding rows in vector mode', async () => {
    const kc = 'kc-nv';
    await seed({ id: 'q-vec', knowledge_ids: [kc], embedding: vec(1, 0) });
    await seed({ id: 'q-null', knowledge_ids: [kc] }); // no embedding
    const rows = await poolFetch(db, { knowledgeId: kc, queryEmbedding: vec(1, 0) });
    expect(rows.map((r) => r.id)).toEqual(['q-vec']);
  });

  it('respects limit', async () => {
    const kc = 'kc-lim';
    for (let i = 0; i < 5; i++) await seed({ id: `q${i}`, knowledge_ids: [kc] });
    const rows = await poolFetch(db, { knowledgeId: kc, limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it('applies difficultyMax ceiling', async () => {
    const kc = 'kc-max';
    await seed({ id: 'q-2', knowledge_ids: [kc], difficulty: 2 });
    await seed({ id: 'q-4', knowledge_ids: [kc], difficulty: 4 });
    const rows = await poolFetch(db, { knowledgeId: kc, difficultyMax: 3 });
    expect(rows.map((r) => r.id)).toEqual(['q-2']);
  });

  it('activeOnly:false includes draft rows', async () => {
    const kc = 'kc-incl';
    await seed({ id: 'q-active', knowledge_ids: [kc] });
    await seed({ id: 'q-draft', knowledge_ids: [kc], draft_status: 'draft' });
    const rows = await poolFetch(db, { knowledgeId: kc, activeOnly: false });
    expect(rows.map((r) => r.id).sort()).toEqual(['q-active', 'q-draft']);
  });

  it('default (non-vector) order is created_at then id', async () => {
    const kc = 'kc-ord';
    await seed({ id: 'q-late', knowledge_ids: [kc], created_at: new Date('2024-02-01T00:00:00Z') });
    await seed({
      id: 'q-early',
      knowledge_ids: [kc],
      created_at: new Date('2024-01-01T00:00:00Z'),
    });
    const rows = await poolFetch(db, { knowledgeId: kc });
    expect(rows.map((r) => r.id)).toEqual(['q-early', 'q-late']);
  });

  it('returns [] when no row matches the KC', async () => {
    await seed({ id: 'q1', knowledge_ids: ['kc-x'] });
    const rows = await poolFetch(db, { knowledgeId: 'kc-absent' });
    expect(rows).toEqual([]);
  });
});
