import { db } from '@/db/client';
import { question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../tests/helpers/db';
import { matcher } from './matcher';

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
