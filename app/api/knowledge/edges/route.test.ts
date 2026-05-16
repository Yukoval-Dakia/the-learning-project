import { knowledge } from '@/db/schema';
import { createKnowledgeEdge } from '@/server/knowledge/edges';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

const KNOWLEDGE_BASE = {
  domain: 'wenyan',
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

async function getEdges(qs = ''): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/knowledge/edges${qs ? `?${qs}` : ''}`, { method: 'GET' }),
  );
}

describe('GET /api/knowledge/edges', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty rows when no edges exist', async () => {
    const res = await getEdges();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('returns all edges desc by created_at', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2', 'k3']);
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    await new Promise((r) => setTimeout(r, 10));
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'k2',
      to_knowledge_id: 'k3',
      relation_type: 'related_to',
    });
    const res = await getEdges();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ from_knowledge_id: string; to_knowledge_id: string }>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].from_knowledge_id).toBe('k2');
    expect(body.rows[1].from_knowledge_id).toBe('k1');
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
    const res = await getEdges('from=k1');
    const body = (await res.json()) as { rows: Array<{ from_knowledge_id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].from_knowledge_id).toBe('k1');
  });

  it('filters by to + relation_type combined', async () => {
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
    const res = await getEdges('to=k2&relation_type=prerequisite');
    const body = (await res.json()) as { rows: Array<{ relation_type: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].relation_type).toBe('prerequisite');
  });
});
