// Phase 1c.1 Step 6 — knowledge_edge single-owner module tests.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { knowledge, knowledge_edge } from '@/db/schema';
import { backfillKnowledgeEdgeGenesis } from '../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  archiveKnowledgeEdgeFromEvents as archiveKnowledgeEdge,
  createKnowledgeEdge,
} from './edges';

const KNOWLEDGE_BASE = {
  domain: 'yuwen',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function seedKnowledge(ids: string[]): Promise<void> {
  const db = testDb();
  const now = new Date();
  for (const id of ids) {
    await db.insert(knowledge).values({
      id,
      name: id,
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...KNOWLEDGE_BASE,
    });
  }
}

describe('createKnowledgeEdge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('rejects duplicate (from, to, relation_type) with 409', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    await expect(
      createKnowledgeEdge(db, {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'prerequisite',
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });
});

describe('archiveKnowledgeEdgeFromEvents', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('allows exactly one concurrent caller to own the archive transition', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const id = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
    });
    await backfillKnowledgeEdgeGenesis(db);
    const firstAt = new Date(Date.now() + 10);
    const secondAt = new Date(firstAt.getTime() + 1000);

    const results = await Promise.all([
      archiveKnowledgeEdge(db, id, { created_at: firstAt }),
      archiveKnowledgeEdge(db, id, { created_at: secondAt }),
    ]);

    expect(results.map((result) => result.archived).sort()).toEqual([false, true]);
    const winnerAt = results[0].archived ? firstAt : secondAt;
    const [row] = await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, id));
    expect(row.archived_at?.getTime()).toBe(winnerAt.getTime());
  });

  it('keeps an already archived edge idempotent and distinguishes a missing id', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const id = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
    });

    await backfillKnowledgeEdgeGenesis(db);
    expect((await archiveKnowledgeEdge(db, id)).archived).toBe(true);
    expect((await archiveKnowledgeEdge(db, id)).archived).toBe(false);
    await expect(archiveKnowledgeEdge(db, 'missing-edge')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});
