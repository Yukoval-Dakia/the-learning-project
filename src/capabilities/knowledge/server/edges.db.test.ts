// Phase 1c.1 Step 6 — knowledge_edge single-owner module tests.

import { knowledge, knowledge_edge } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  createKnowledgeEdge,
  getKnowledgeEdgeById,
  listKnowledgeEdges,
  reactivateKnowledgeEdge,
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

  it('inserts a valid edge and returns its id', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const id = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    expect(id).toBeTruthy();
    const rows = await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].from_knowledge_id).toBe('k1');
    expect(rows[0].to_knowledge_id).toBe('k2');
    expect(rows[0].relation_type).toBe('prerequisite');
    expect(rows[0].weight).toBe(1); // default
  });

  it('accepts experimental:* relation_type', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const id = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'experimental:cohort_resemblance',
    });
    const stored = await getKnowledgeEdgeById(db, id);
    expect(stored?.relation_type).toBe('experimental:cohort_resemblance');
  });

  it('rejects unknown relation_type with 400', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    await expect(
      createKnowledgeEdge(db, {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'totally_made_up',
      }),
    ).rejects.toMatchObject({ code: 'validation_error', status: 400 });
  });

  it('rejects unknown from/to knowledge_id with 404', async () => {
    const db = testDb();
    await seedKnowledge(['k1']);
    await expect(
      createKnowledgeEdge(db, {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k_missing',
        relation_type: 'related_to',
      }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('rejects archived knowledge_id with 404', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    await testDb().update(knowledge).set({ archived_at: new Date() }).where(eq(knowledge.id, 'k2'));
    await expect(
      createKnowledgeEdge(db, {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'related_to',
      }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
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

  it('allows same (from, to) with different relation_type', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const id1 = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    const id2 = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
    });
    expect(id1).not.toBe(id2);
  });

  it('honours custom weight', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const id = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
      weight: 0.7,
    });
    const stored = await getKnowledgeEdgeById(db, id);
    expect(stored?.weight).toBeCloseTo(0.7, 5);
  });
});

describe('listKnowledgeEdges', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns all active edges desc by created_at', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2', 'k3']);
    const id1 = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    // sleep just enough to differentiate created_at when timestamps round to ms
    await new Promise((r) => setTimeout(r, 10));
    const id2 = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k2',
      to_knowledge_id: 'k3',
      relation_type: 'related_to',
    });
    const rows = await listKnowledgeEdges(db);
    expect(rows.map((r) => r.id)).toEqual([id2, id1]);
  });

  it('filters by from', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2', 'k3']);
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'k3',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
    });
    const rows = await listKnowledgeEdges(db, { from: 'k1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].from_knowledge_id).toBe('k1');
  });

  it('filters by to', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2', 'k3']);
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'k3',
      to_knowledge_id: 'k1',
      relation_type: 'related_to',
    });
    const rows = await listKnowledgeEdges(db, { to: 'k2' });
    expect(rows).toHaveLength(1);
    expect(rows[0].to_knowledge_id).toBe('k2');
  });

  it('filters by relation_type', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
    });
    const rows = await listKnowledgeEdges(db, { relation_type: 'prerequisite' });
    expect(rows).toHaveLength(1);
    expect(rows[0].relation_type).toBe('prerequisite');
  });

  it('excludes archived edges by default', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const id = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    await testDb()
      .update(knowledge_edge)
      .set({ archived_at: new Date() })
      .where(eq(knowledge_edge.id, id));
    const active = await listKnowledgeEdges(db);
    expect(active).toEqual([]);
    const withArchived = await listKnowledgeEdges(db, { includeArchived: true });
    expect(withArchived).toHaveLength(1);
  });
});

// YUK-543 (OCR O1) — reactivateKnowledgeEdge tombstone-only contract guard.
describe('reactivateKnowledgeEdge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  const REACTIVATE_INPUT = {
    weight: 0.5,
    reasoning: 'revived',
    actor_kind: 'user',
    actor_ref: 'self',
    created_at: new Date('2026-07-02T00:00:00.000Z'),
  };

  it('revives an archived tombstone (archived_at cleared, columns refreshed)', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const id = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
    });
    await db
      .update(knowledge_edge)
      .set({ archived_at: new Date() })
      .where(eq(knowledge_edge.id, id));
    await reactivateKnowledgeEdge(db, id, REACTIVATE_INPUT);
    const row = (await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, id)))[0];
    expect(row.archived_at).toBeNull();
    expect(row.weight).toBe(0.5);
    expect(row.reasoning).toBe('revived');
    expect(row.created_at).toEqual(REACTIVATE_INPUT.created_at);
  });

  it('THROWS on a LIVE edge (refuses to overwrite a live row) — contract guard', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const id = await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
      weight: 1,
      reasoning: 'original',
    });
    await expect(reactivateKnowledgeEdge(db, id, REACTIVATE_INPUT)).rejects.toThrow(
      /not an archived tombstone/i,
    );
    // the live row is untouched.
    const row = (await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, id)))[0];
    expect(row.archived_at).toBeNull();
    expect(row.weight).toBe(1);
    expect(row.reasoning).toBe('original');
  });

  it('THROWS on a missing id', async () => {
    const db = testDb();
    await expect(reactivateKnowledgeEdge(db, 'nope', REACTIVATE_INPUT)).rejects.toThrow(
      /not an archived tombstone/i,
    );
  });
});
