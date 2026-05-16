// Phase 1c.1 Step 9.C — `/api/knowledge/proposals` over the event stream.

import { event, knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

const KNOWLEDGE_BASE = {
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function seedKnowledge(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: 'wenyan',
    parent_id: null,
    ...KNOWLEDGE_BASE,
    created_at: now,
    updated_at: now,
  });
}

async function seedProposeEvent(opts: {
  id: string;
  name: string;
  parent_id: string;
  reasoning: string;
  outcome?: 'success' | 'partial';
  created_at?: Date;
}) {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'propose',
    subject_kind: 'knowledge',
    subject_id: opts.id, // placeholder — subject is the prospective knowledge id
    outcome: opts.outcome ?? 'partial',
    payload: {
      name: opts.name,
      parent_id: opts.parent_id,
      reasoning: opts.reasoning,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
}

async function seedRateEvent(opts: {
  id: string;
  propose_event_id: string;
  rating: 'accept' | 'dismiss' | 'rollback';
  created_at?: Date;
}) {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: opts.propose_event_id,
    outcome: 'success',
    payload: { rating: opts.rating },
    caused_by_event_id: opts.propose_event_id,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
}

async function getProposals(qs = '') {
  return GET(
    new Request(`http://localhost/api/knowledge/proposals${qs ? `?${qs}` : ''}`, {
      method: 'GET',
    }),
  );
}

describe('GET /api/knowledge/proposals', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns pending propose events by default in legacy proposal-shape', async () => {
    await seedKnowledge('parent');
    await seedProposeEvent({
      id: 'p1',
      name: 'X',
      parent_id: 'parent',
      reasoning: 'because',
    });
    // p2: already accepted
    await seedProposeEvent({ id: 'p2', name: 'Y', parent_id: 'parent', reasoning: 'r2' });
    await seedRateEvent({ id: 'rate_p2', propose_event_id: 'p2', rating: 'accept' });

    const res = await getProposals();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        id: string;
        kind: string;
        payload: { mutation: string; name: string; parent_id: string };
        reasoning: string;
        status: string;
        proposed_at: string;
        decided_at: string | null;
      }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('p1');
    expect(body.rows[0].kind).toBe('knowledge');
    expect(body.rows[0].payload).toEqual({ mutation: 'propose_new', name: 'X', parent_id: 'parent' });
    expect(body.rows[0].reasoning).toBe('because');
    expect(body.rows[0].status).toBe('pending');
    expect(body.rows[0].decided_at).toBeNull();
  });

  it('returns accepted proposals when status=accepted', async () => {
    await seedKnowledge('parent');
    await seedProposeEvent({ id: 'p1', name: 'A', parent_id: 'parent', reasoning: 'r' });
    await seedProposeEvent({ id: 'p2', name: 'B', parent_id: 'parent', reasoning: 'r' });
    await seedRateEvent({ id: 'rp2', propose_event_id: 'p2', rating: 'accept' });

    const res = await getProposals('status=accepted');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; status: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('p2');
    expect(body.rows[0].status).toBe('accepted');
  });

  it('returns dismissed proposals when status=dismissed', async () => {
    await seedKnowledge('parent');
    await seedProposeEvent({ id: 'p1', name: 'X', parent_id: 'parent', reasoning: 'r' });
    await seedRateEvent({ id: 'rp1', propose_event_id: 'p1', rating: 'dismiss' });

    const res = await getProposals('status=dismissed');
    const body = (await res.json()) as { rows: Array<{ id: string; status: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('p1');
    expect(body.rows[0].status).toBe('dismissed');
  });

  it('returns empty array when no proposals match', async () => {
    const res = await getProposals();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(0);
  });

  it('handles multiple rate events on the same propose — latest wins', async () => {
    await seedKnowledge('parent');
    await seedProposeEvent({ id: 'p1', name: 'X', parent_id: 'parent', reasoning: 'r' });
    const t1 = new Date('2026-05-15T10:00:00Z');
    const t2 = new Date('2026-05-15T11:00:00Z');
    await seedRateEvent({ id: 'r1', propose_event_id: 'p1', rating: 'dismiss', created_at: t1 });
    await seedRateEvent({ id: 'r2', propose_event_id: 'p1', rating: 'accept', created_at: t2 });

    const res = await getProposals('status=accepted');
    const body = (await res.json()) as { rows: Array<{ id: string; status: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].status).toBe('accepted');
  });
});
