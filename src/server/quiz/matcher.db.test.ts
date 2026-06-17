import { db } from '@/db/client';
import { question } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../../tests/helpers/db';
import { matcher } from './matcher';

// 1024-dim vector (matches EMBED_DIMS) with the first two components set — mirrors
// pool-fetch.db.test.ts's vec() helper so matcher tests seed embeddings the same way.
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

describe('matcher — Task 1 (active hits, no draft, no residual)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns active pool hits sliced to limit, difficulty floor applied, by created_at order', async () => {
    const kc = 'kc-m1';
    // three active rows on the same KC, all difficulty >= 3, distinct created_at.
    await seed({
      id: 'q-a',
      knowledge_ids: [kc],
      difficulty: 3,
      created_at: new Date('2024-01-01T00:00:00Z'),
    });
    await seed({
      id: 'q-b',
      knowledge_ids: [kc],
      difficulty: 4,
      created_at: new Date('2024-01-02T00:00:00Z'),
    });
    await seed({
      id: 'q-c',
      knowledge_ids: [kc],
      difficulty: 5,
      created_at: new Date('2024-01-03T00:00:00Z'),
    });
    // a below-floor row + a different-KC row that must be excluded.
    await seed({
      id: 'q-lo',
      knowledge_ids: [kc],
      difficulty: 2,
      created_at: new Date('2024-01-04T00:00:00Z'),
    });
    await seed({
      id: 'q-other',
      knowledge_ids: ['kc-other'],
      difficulty: 5,
      created_at: new Date('2024-01-05T00:00:00Z'),
    });

    const result = await matcher(db, { knowledgeId: kc, difficultyMin: 3, limit: 2 });

    // two earliest of the three qualifying rows (same tier → stable created_at order).
    expect(result.used.map((u) => u.question_id)).toEqual(['q-a', 'q-b']);
    expect(result.used).toHaveLength(2);
    // no draft handling / no residual generation in Task 1.
    expect(result.residual).toEqual([]);
    expect(result.satisfiedFromPool).toBe(true);
    // every hit is a real active row, never promoted.
    for (const u of result.used) {
      expect(u.promotedFromDraft).toBe(false);
      expect(u.verifyEventId).toBeUndefined();
    }
    // tier/source projection: bare source='authentic' with no ingestion provenance
    // derives tier 4 (deriveSourceTier keys on metadata.ingestion_session_id, NOT the
    // bare source column — mix-layer defence). Source string is projected verbatim.
    expect(result.used.every((u) => u.source === 'authentic')).toBe(true);
    expect(result.used.every((u) => u.tier === 4)).toBe(true);
  });
});

describe('matcher — Task 2 (cosine soft ranking + NULL embedding 降级)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('cosine-ranks pool hits nearest-first when queryEmbedding given (hybrid)', async () => {
    const kc = 'kc-vec';
    // three active rows, distinct embeddings; created_at order is the inverse of the
    // intended cosine order so a pass can only come from cosine ranking, not insertion.
    await seed({
      id: 'q1',
      knowledge_ids: [kc],
      embedding: vec(1, 0),
      created_at: new Date('2024-01-01T00:00:00Z'),
    });
    await seed({
      id: 'q2',
      knowledge_ids: [kc],
      embedding: vec(0, 1),
      created_at: new Date('2024-01-02T00:00:00Z'),
    });
    await seed({
      id: 'q3',
      knowledge_ids: [kc],
      embedding: vec(-1, 0),
      created_at: new Date('2024-01-03T00:00:00Z'),
    });

    // query vector pointing almost exactly at q2's direction (0,1).
    const result = await matcher(db, {
      knowledgeId: kc,
      queryEmbedding: vec(0.05, 0.95),
      limit: 3,
    });

    expect(result.used[0].question_id).toBe('q2'); // cosine nearest first
    expect(result.used).toHaveLength(3);
  });

  it('queryText 路 B — embeds via injected embedFn exactly once', async () => {
    const kc = 'kc-text';
    await seed({ id: 'q-near', knowledge_ids: [kc], embedding: vec(0, 1) });
    await seed({ id: 'q-far', knowledge_ids: [kc], embedding: vec(1, 0) });

    const embedFn = vi.fn().mockResolvedValue(vec(0.05, 0.95));
    const result = await matcher(
      db,
      { knowledgeId: kc, queryText: 'near q-near direction', limit: 1 },
      { embedFn },
    );

    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledWith('near q-near direction');
    // the embedded vector is forwarded as queryEmbedding → cosine nearest wins.
    expect(result.used[0].question_id).toBe('q-near');
  });

  it('queryEmbedding takes priority over queryText — embedFn not called', async () => {
    const kc = 'kc-prio';
    await seed({ id: 'q-near', knowledge_ids: [kc], embedding: vec(0, 1) });
    await seed({ id: 'q-far', knowledge_ids: [kc], embedding: vec(1, 0) });

    const embedFn = vi.fn().mockResolvedValue(vec(1, 0));
    const result = await matcher(
      db,
      { knowledgeId: kc, queryEmbedding: vec(0.05, 0.95), queryText: 'ignored', limit: 1 },
      { embedFn },
    );

    // queryEmbedding present → embedFn must NOT be consulted (路 A 优先, §9 开放问题 3).
    expect(embedFn).not.toHaveBeenCalled();
    expect(result.used[0].question_id).toBe('q-near');
  });

  it('vector mode excludes NULL-embedding rows but does not crash (§7 降级)', async () => {
    const kc = 'kc-null-vec';
    await seed({ id: 'q-vec', knowledge_ids: [kc], embedding: vec(1, 0) });
    await seed({ id: 'q-null', knowledge_ids: [kc] }); // NULL embedding

    const result = await matcher(db, { knowledgeId: kc, queryEmbedding: vec(1, 0), limit: 5 });

    // poolFetch's isNotNull(embedding) guard drops the NULL row in vector mode; matcher
    // uses the rows that came back and does not throw.
    expect(result.used.map((u) => u.question_id)).toEqual(['q-vec']);
  });

  it('scalar mode (no queryEmbedding) recalls NULL-embedding rows (§7 降级)', async () => {
    const kc = 'kc-null-scalar';
    await seed({
      id: 'q-vec',
      knowledge_ids: [kc],
      embedding: vec(1, 0),
      created_at: new Date('2024-01-02T00:00:00Z'),
    });
    await seed({
      id: 'q-null',
      knowledge_ids: [kc],
      created_at: new Date('2024-01-01T00:00:00Z'),
    }); // NULL embedding

    const result = await matcher(db, { knowledgeId: kc, limit: 5 });

    // no query vector → pure scalar pool, NULL-embedding rows recalled too, created_at order.
    expect(result.used.map((u) => u.question_id).sort()).toEqual(['q-null', 'q-vec']);
  });
});
