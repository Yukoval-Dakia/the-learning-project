import { knowledge } from '@/db/schema';
import { createKnowledgeEdge } from '@/server/knowledge/edges';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET, POST } from './route';

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

async function postEdge(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/knowledge/edges', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
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

describe('POST /api/knowledge/edges', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates an edge with 201 + { id }', async () => {
    await seedKnowledge(['k1', 'k2']);
    const res = await postEdge({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBeTruthy();
  });

  it('accepts experimental:* relation_type', async () => {
    await seedKnowledge(['k1', 'k2']);
    const res = await postEdge({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'experimental:cohort_resemblance',
    });
    expect(res.status).toBe(201);
  });

  it('400s on invalid relation_type', async () => {
    await seedKnowledge(['k1', 'k2']);
    const res = await postEdge({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'totally_made_up',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('400s on missing required fields', async () => {
    const res = await postEdge({
      from_knowledge_id: 'k1',
      relation_type: 'prerequisite',
    });
    expect(res.status).toBe(400);
  });

  it('404s when from/to knowledge_id unknown', async () => {
    await seedKnowledge(['k1']);
    const res = await postEdge({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k_missing',
      relation_type: 'related_to',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('409s on duplicate (from, to, relation_type)', async () => {
    await seedKnowledge(['k1', 'k2']);
    const r1 = await postEdge({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    expect(r1.status).toBe(201);
    const r2 = await postEdge({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: string };
    expect(body.error).toBe('conflict');
  });

  it('honours weight + reasoning', async () => {
    await seedKnowledge(['k1', 'k2']);
    const res = await postEdge({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
      weight: 0.6,
      reasoning: 'AI proposed this edge with 0.6 confidence',
    });
    expect(res.status).toBe(201);
  });
});
