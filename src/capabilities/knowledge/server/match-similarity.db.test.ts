// P1 (YUK-489) — matchKnowledgeBySimilarity DB tests. Uses orthogonal unit basis vectors
// for predictable cosine distances: <=>(unit(i), unit(i)) = 0 (identical direction),
// <=>(unit(i), unit(j≠i)) = 1 (orthogonal). Verifies nearest-first ordering, topK, and that
// NULL-embedding + archived KCs are excluded.
import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { matchKnowledgeBySimilarity } from './match-similarity';

const DIMS = 1024;

/** A 1024-dim unit basis vector: 1 at index `i`, 0 elsewhere. */
function unitVec(i: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[i] = 1;
  return v;
}

async function seedKc(
  db: ReturnType<typeof testDb>,
  id: string,
  embedding: number[] | null,
  opts: { domain?: string | null; parent_id?: string | null; archived?: boolean } = {},
): Promise<void> {
  const now = new Date();
  const values: Record<string, unknown> = {
    id,
    name: id,
    domain: opts.domain ?? null,
    parent_id: opts.parent_id ?? null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    archived_at: opts.archived ? now : null,
    created_at: now,
    updated_at: now,
    version: 0,
  };
  // Omit embedding entirely for the NULL case (column defaults NULL).
  if (embedding) values.embedding = embedding;
  await db.insert(knowledge).values(values as typeof knowledge.$inferInsert);
}

describe('matchKnowledgeBySimilarity', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns active embedded KCs nearest-first by cosine distance', async () => {
    const db = testDb();
    await seedKc(db, 'kc-a', unitVec(0));
    await seedKc(db, 'kc-b', unitVec(1));
    await seedKc(db, 'kc-c', unitVec(2));

    const out = await matchKnowledgeBySimilarity(db, unitVec(0), { topK: 5 });

    expect(out.map((r) => r.knowledge_id).sort()).toEqual(['kc-a', 'kc-b', 'kc-c']);
    // Nearest first: kc-a (same direction → distance ~0), then the orthogonal pair (~1).
    expect(out[0]?.knowledge_id).toBe('kc-a');
    expect(out[0]?.cosine_distance).toBeLessThan(0.01);
    expect(out[1]?.cosine_distance).toBeGreaterThan(0.99);
    // Distances are non-decreasing (the ORDER BY contract).
    const dists = out.map((r) => r.cosine_distance);
    expect(dists).toEqual([...dists].sort((a, b) => a - b));
  });

  it('respects the topK limit (still nearest-first)', async () => {
    const db = testDb();
    await seedKc(db, 'kc-a', unitVec(0));
    await seedKc(db, 'kc-b', unitVec(1));
    await seedKc(db, 'kc-c', unitVec(2));

    const out = await matchKnowledgeBySimilarity(db, unitVec(0), { topK: 2 });

    expect(out).toHaveLength(2);
    expect(out[0]?.knowledge_id).toBe('kc-a');
  });

  it('excludes NULL-embedding and archived KCs', async () => {
    const db = testDb();
    await seedKc(db, 'kc-a', unitVec(0)); // active + embedded → included
    await seedKc(db, 'kc-null', null); // no embedding (awaiting backfill) → excluded
    await seedKc(db, 'kc-archived', unitVec(0), { archived: true }); // archived → excluded

    const out = await matchKnowledgeBySimilarity(db, unitVec(0), { topK: 10 });

    const ids = out.map((r) => r.knowledge_id);
    expect(ids).toContain('kc-a');
    expect(ids).not.toContain('kc-null');
    expect(ids).not.toContain('kc-archived');
  });

  it('projects domain + parent_id for caller-side effective-domain filtering', async () => {
    const db = testDb();
    await seedKc(db, 'math-root', unitVec(0), { domain: 'math' });
    await seedKc(db, 'math-child', unitVec(1), { domain: null, parent_id: 'math-root' });

    const out = await matchKnowledgeBySimilarity(db, unitVec(0), { topK: 5 });
    const root = out.find((r) => r.knowledge_id === 'math-root');
    const child = out.find((r) => r.knowledge_id === 'math-child');
    expect(root?.domain).toBe('math');
    expect(child?.domain).toBeNull();
    expect(child?.parent_id).toBe('math-root');
  });

  it('returns [] for an empty query vector (caller routes to propose)', async () => {
    const db = testDb();
    await seedKc(db, 'kc-a', unitVec(0));

    expect(await matchKnowledgeBySimilarity(db, [], { topK: 5 })).toEqual([]);
  });
});
