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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

// YUK-384 — the POST handler fires a best-effort hub-sync wake via getStartedBoss (the
// app-process enqueue path, P2-b). Mock it so we control the boss; default REJECT (boss
// unavailable → wake swallows → no-op) so every other test is unaffected.
const bossMock = vi.hoisted(() => ({
  getStartedBoss: vi.fn(),
  getRunningBoss: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/server/boss/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/boss/client')>();
  return {
    ...actual,
    getStartedBoss: () => bossMock.getStartedBoss(),
    getRunningBoss: () => bossMock.getRunningBoss(),
  };
});

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
    bossMock.getRunningBoss.mockReset();
    bossMock.getStartedBoss.mockReset().mockRejectedValue(new Error('no boss in test'));
    bossMock.send.mockReset().mockResolvedValue('job-id');
  });

  it('YUK-384: fires exactly one hub_sync_mutation_wake after the edge commit', async () => {
    bossMock.getStartedBoss.mockResolvedValue({ send: bossMock.send });
    await seedKnowledge(['k1', 'k2']);
    const res = await postEdge({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    expect(res.status).toBe(201);
    // W1: the wake is fire-and-forget (`void`), so the send lands after the response
    // returns — await it instead of asserting synchronously.
    await vi.waitFor(() => expect(bossMock.send).toHaveBeenCalledTimes(1));
    expect(bossMock.send).toHaveBeenCalledWith(
      'hub_sync_mutation_wake',
      {},
      {
        singletonKey: 'hub_sync_mutation_wake',
        singletonSeconds: 5,
      },
    );
  });

  it('YUK-384: a wake send rejection does NOT affect the committed edge (201)', async () => {
    bossMock.getStartedBoss.mockResolvedValue({ send: bossMock.send });
    bossMock.send.mockRejectedValue(new Error('boss unavailable'));
    await seedKnowledge(['k1', 'k2']);
    const res = await postEdge({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
    });
    expect(res.status).toBe(201);
    // The edge is durably committed regardless of the failed wake.
    const rows = await testDb().select().from(knowledge_edge);
    expect(rows).toHaveLength(1);
    // Let the fire-and-forget wake settle (its rejection is swallowed) so it does not
    // leak into the next test.
    await vi.waitFor(() => expect(bossMock.send).toHaveBeenCalled());
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

// YUK-737 — the direct POST /edges path had NO accept-time topology gate: a direct caller could write
// a `prerequisite` edge that closes a cycle the proposal-accept fold would reject. These pin the new
// gate (cycle → clean 409, not a 500) + a legal regression, under the faithful prod flip (ON).
describe('POST /api/knowledge/edges — YUK-737 topology gate', () => {
  beforeEach(async () => {
    await resetDb();
    // PROJECTION_IS_WRITER=1 is the LIVE prod state: the create projects the edge through the fold,
    // whose ADR-0034 topology reject THROWS and rolls the write back; runEdgeTopologyGate's
    // translateReject then surfaces it as a clean 409 (mirrors the accept-path lock suite).
    vi.stubEnv('PROJECTION_IS_WRITER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('409s when a direct create closes a prerequisite cycle (tc_a->tc_b live, tc_b->tc_a rejected)', async () => {
    const db = testDb();
    await seedKnowledge(['tc_a', 'tc_b']);
    // tc_a -> tc_b committed first (via the same POST route).
    const r1 = await postEdge({
      from_knowledge_id: 'tc_a',
      to_knowledge_id: 'tc_b',
      relation_type: 'prerequisite',
    });
    expect(r1.status).toBe(201);
    // tc_b -> tc_a reverses it. NOTE: distinct UNIQUE(from,to,type) key, so the unique constraint
    // does NOT catch this — only the ADR-0034 topology gate (fold) does.
    const r2 = await postEdge({
      from_knowledge_id: 'tc_b',
      to_knowledge_id: 'tc_a',
      relation_type: 'prerequisite',
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: string; message: string };
    expect(body.error).toMatch(/cycle|direction_contradiction/);

    // No tc_b -> tc_a edge landed (whole tx rolled back); only tc_a -> tc_b is live.
    const live = (await db.select().from(knowledge_edge)).filter((e) => e.archived_at === null);
    expect(live).toHaveLength(1);
    expect(live[0].from_knowledge_id).toBe('tc_a');
    expect(live[0].to_knowledge_id).toBe('tc_b');
  });

  it('creates a legal (non-cyclic) prerequisite chain under the gate (201, 201)', async () => {
    await seedKnowledge(['tl_a', 'tl_b', 'tl_c']);
    const r1 = await postEdge({
      from_knowledge_id: 'tl_a',
      to_knowledge_id: 'tl_b',
      relation_type: 'prerequisite',
    });
    expect(r1.status).toBe(201);
    // tl_b -> tl_c extends the chain; no cycle, so the gate passes.
    const r2 = await postEdge({
      from_knowledge_id: 'tl_b',
      to_knowledge_id: 'tl_c',
      relation_type: 'prerequisite',
    });
    expect(r2.status).toBe(201);
  });
});
