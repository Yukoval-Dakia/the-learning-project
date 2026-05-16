// Phase 1c.2 — POST /api/knowledge/edges/proposals/[id] decides an edge proposal:
// writes a rate event + (for accept-class decisions) inserts the edge + writes
// a generate event, all in one transaction.

import { newId } from '@/core/ids';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../../tests/helpers/db';
import { POST } from './route';

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

async function seedProposeEdgeEvent(opts: {
  id?: string;
  subject_id?: string;
  from: string;
  to: string;
  relation_type?: string;
  weight?: number;
  reasoning?: string;
  created_at?: Date;
}): Promise<string> {
  const db = testDb();
  const id = opts.id ?? newId();
  await writeEvent(db, {
    id,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'propose',
    subject_kind: 'knowledge_edge',
    subject_id: opts.subject_id ?? `edge_proposed_${id}`,
    outcome: 'partial',
    payload: {
      from_knowledge_id: opts.from,
      to_knowledge_id: opts.to,
      relation_type: opts.relation_type ?? 'prerequisite',
      weight: opts.weight ?? 1,
      reasoning: opts.reasoning ?? 'AI thinks A is prerequisite for B',
    },
    caused_by_event_id: null,
    created_at: opts.created_at ?? new Date(),
  });
  return id;
}

async function decide(proposeId: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/knowledge/edges/proposals/${proposeId}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id: proposeId }) },
  );
}

describe('POST /api/knowledge/edges/proposals/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('accept: writes rate + generate events and inserts a knowledge_edge row', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const proposeId = await seedProposeEdgeEvent({ from: 'k1', to: 'k2' });

    const res = await decide(proposeId, { decision: 'accept' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rate_event_id: string;
      generate_event_id: string | null;
      edge_id: string | null;
    };
    expect(body.rate_event_id).toBeTruthy();
    expect(body.generate_event_id).toBeTruthy();
    expect(body.edge_id).toBeTruthy();

    const edges = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, body.edge_id as string));
    expect(edges).toHaveLength(1);
    expect(edges[0].from_knowledge_id).toBe('k1');
    expect(edges[0].to_knowledge_id).toBe('k2');
    expect(edges[0].relation_type).toBe('prerequisite');

    const rateRows = await db.select().from(event).where(eq(event.id, body.rate_event_id));
    expect((rateRows[0].payload as { rating: string }).rating).toBe('accept');
    expect(rateRows[0].caused_by_event_id).toBe(proposeId);

    const generateRows = await db
      .select()
      .from(event)
      .where(eq(event.id, body.generate_event_id as string));
    expect(generateRows[0].subject_id).toBe(body.edge_id);
    expect((generateRows[0].payload as { propose_event_id: string }).propose_event_id).toBe(
      proposeId,
    );
  });

  it('reverse: swaps from/to before creating the edge and records the rating flag', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const proposeId = await seedProposeEdgeEvent({ from: 'k1', to: 'k2' });

    const res = await decide(proposeId, { decision: 'reverse' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edge_id: string; rate_event_id: string };

    const edges = await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, body.edge_id));
    expect(edges[0].from_knowledge_id).toBe('k2');
    expect(edges[0].to_knowledge_id).toBe('k1');

    const rateRows = await db.select().from(event).where(eq(event.id, body.rate_event_id));
    const ratePayload = rateRows[0].payload as { rating: string; new_direction_reversed: boolean };
    expect(ratePayload.rating).toBe('reverse');
    expect(ratePayload.new_direction_reversed).toBe(true);
  });

  it('change_type: requires new_relation_type and writes it to both edge + rate event', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const proposeId = await seedProposeEdgeEvent({
      from: 'k1',
      to: 'k2',
      relation_type: 'prerequisite',
    });

    const res = await decide(proposeId, {
      decision: 'change_type',
      new_relation_type: 'related_to',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edge_id: string; rate_event_id: string };

    const edges = await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, body.edge_id));
    expect(edges[0].relation_type).toBe('related_to');

    const rateRows = await db.select().from(event).where(eq(event.id, body.rate_event_id));
    const ratePayload = rateRows[0].payload as { rating: string; new_relation_type: string };
    expect(ratePayload.rating).toBe('change_type');
    expect(ratePayload.new_relation_type).toBe('related_to');
  });

  it('change_type without new_relation_type returns 400', async () => {
    await seedKnowledge(['k1', 'k2']);
    const proposeId = await seedProposeEdgeEvent({ from: 'k1', to: 'k2' });
    const res = await decide(proposeId, { decision: 'change_type' });
    expect(res.status).toBe(400);
  });

  it('dismiss: records rate event only — no edge, no generate', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    const proposeId = await seedProposeEdgeEvent({ from: 'k1', to: 'k2' });

    const res = await decide(proposeId, { decision: 'dismiss' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rate_event_id: string;
      generate_event_id: string | null;
      edge_id: string | null;
    };
    expect(body.generate_event_id).toBeNull();
    expect(body.edge_id).toBeNull();

    const edges = await db.select().from(knowledge_edge);
    expect(edges).toHaveLength(0);

    const generates = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'generate'),
          eq(event.subject_kind, 'knowledge_edge'),
          eq(event.caused_by_event_id, proposeId),
        ),
      );
    expect(generates).toHaveLength(0);
  });

  it('re-submitting the same decision is idempotent (returns existing ids)', async () => {
    await seedKnowledge(['k1', 'k2']);
    const proposeId = await seedProposeEdgeEvent({ from: 'k1', to: 'k2' });

    const first = await decide(proposeId, { decision: 'accept' });
    const firstBody = (await first.json()) as { rate_event_id: string; edge_id: string };

    const second = await decide(proposeId, { decision: 'accept' });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      rate_event_id: string;
      edge_id: string;
      idempotent?: boolean;
    };
    expect(secondBody.rate_event_id).toBe(firstBody.rate_event_id);
    expect(secondBody.edge_id).toBe(firstBody.edge_id);
    expect(secondBody.idempotent).toBe(true);
  });

  it('submitting a different decision after one is recorded is 409', async () => {
    await seedKnowledge(['k1', 'k2']);
    const proposeId = await seedProposeEdgeEvent({ from: 'k1', to: 'k2' });
    await decide(proposeId, { decision: 'accept' });
    const res = await decide(proposeId, { decision: 'dismiss' });
    expect(res.status).toBe(409);
  });

  it('404s when propose event id does not exist', async () => {
    const res = await decide('does_not_exist', { decision: 'accept' });
    expect(res.status).toBe(404);
  });

  it('400s when target event is not a knowledge_edge proposal', async () => {
    const db = testDb();
    const wrongId = newId();
    await db.insert(event).values({
      id: wrongId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: { answer_md: 'x', answer_image_refs: [] },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });
    const res = await decide(wrongId, { decision: 'accept' });
    expect(res.status).toBe(400);
  });

  it('404s when an endpoint knowledge node is missing', async () => {
    await seedKnowledge(['k1']);
    const proposeId = await seedProposeEdgeEvent({ from: 'k1', to: 'k_missing' });
    const res = await decide(proposeId, { decision: 'accept' });
    expect(res.status).toBe(404);
  });
});
