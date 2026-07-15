import {
  CreateKnowledgeEdgeResponseSchema,
  KnowledgeEdgeCollectionResponseSchema,
  KnowledgeEdgeSchema,
} from '@/capabilities/knowledge/api/contracts';
import { createKnowledgeEdge } from '@/capabilities/knowledge/server/edges';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { edgeRowToSnapshot, gatherAndFoldKnowledgeEdge } from '@/server/projections/gather';
import { diffSnapshots } from '@/server/projections/snapshot-diff';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET, POST, getEdge } from './edges';

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
    const json = await res.json();
    KnowledgeEdgeCollectionResponseSchema.parse(json);
    const body = json as {
      data: unknown[];
      rows: unknown[];
      page: { limit: number; next_cursor: string | null };
    };
    expect(body.rows).toEqual([]);
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ limit: 500, next_cursor: null });
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

  it('cursor pagination is stable for equal created_at values', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2', 'k3', 'k4']);
    const createdAt = new Date('2026-05-01T00:00:00Z');
    const ids = await Promise.all([
      createKnowledgeEdge(db, {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'related_to',
        created_at: createdAt,
      }),
      createKnowledgeEdge(db, {
        from_knowledge_id: 'k2',
        to_knowledge_id: 'k3',
        relation_type: 'related_to',
        created_at: createdAt,
      }),
      createKnowledgeEdge(db, {
        from_knowledge_id: 'k3',
        to_knowledge_id: 'k4',
        relation_type: 'related_to',
        created_at: createdAt,
      }),
    ]);
    const expected = [...ids].sort().reverse();

    const first = (await (await getEdges('limit=2')).json()) as {
      data: Array<{ id: string }>;
      page: { next_cursor: string | null };
    };
    expect(first.data.map((edge) => edge.id)).toEqual(expected.slice(0, 2));

    const second = (await (
      await getEdges(`limit=2&cursor=${encodeURIComponent(first.page.next_cursor ?? '')}`)
    ).json()) as typeof first;
    expect(second.data.map((edge) => edge.id)).toEqual(expected.slice(2));
    expect(second.page.next_cursor).toBeNull();
  });

  it('rejects an invalid cursor', async () => {
    expect((await getEdges('cursor=not-a-cursor')).status).toBe(400);
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
    const json = await res.json();
    CreateKnowledgeEdgeResponseSchema.parse(json);
    const body = json as { id: string };
    expect(body.id).toBeTruthy();
    expect(res.headers.get('Location')).toBe(`/api/knowledge/edges/${body.id}`);

    const detail = await getEdge(new Request(`http://localhost/api/knowledge/edges/${body.id}`), {
      id: body.id,
    });
    expect(detail.status).toBe(200);
    const detailJson = await detail.json();
    KnowledgeEdgeSchema.parse(detailJson);
    expect(detailJson).toMatchObject({ id: body.id, relation_type: 'prerequisite' });
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

  // YUK-471 BYPASS-2 fence — a manual edge create is EVENT-SOURCED + uses the fixed {user, self}
  // actor; any client-sent `created_by` is ignored (stripped). Replaces the old "400 on bad
  // created_by shape" test: created_by is no longer a route input.
  it('writes an event-sourced edge with the fixed {user, self} actor, ignoring a client created_by', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const res = await postEdge({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
      created_by: { kind: 'agent', task: 'x' }, // ignored now (was rejected pre-fence)
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    // created_by is the fold's {actor_kind, actor_ref} object (NOT the client value, NOT a string).
    const edge = (await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, id)))[0];
    expect(edge?.created_by).toEqual({ actor_kind: 'user', actor_ref: 'self' });

    // a generate(create) event was written for the edge (event-sourced — survives the SoT flip).
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.subject_kind, 'knowledge_edge'), eq(event.subject_id, id)));
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('generate');

    // the keystone: fold(events) == the live row (the projection reproduces this edge).
    const folded = await gatherAndFoldKnowledgeEdge(db, id);
    const diffs = diffSnapshots(
      edgeRowToSnapshot(edge as never) as Record<string, unknown>,
      folded as Record<string, unknown> | null,
    );
    expect(diffs).toEqual([]);
  });
});
