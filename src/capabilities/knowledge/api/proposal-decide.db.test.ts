// Phase 1c.1 Step 9.I — proposals/[id]/route.test rewritten for event-based proposals.

import { event, knowledge } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './proposal-decide';

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
    archived_at: null,
    created_at: now,
    updated_at: now,
  });
}

async function seedProposeEvent(opts: {
  id: string;
  name: string;
  parent_id: string | null;
  reasoning?: string;
}) {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'propose',
    subject_kind: 'knowledge',
    subject_id: opts.id,
    outcome: 'partial',
    payload: {
      name: opts.name,
      parent_id: opts.parent_id,
      reasoning: opts.reasoning ?? 'r',
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
}

async function seedRateEvent(opts: {
  id: string;
  propose_event_id: string;
  rating: 'accept' | 'dismiss';
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
    created_at: new Date(),
  });
}

async function decide(id: string, body: unknown) {
  return POST(
    new Request(`http://localhost/api/knowledge/proposals/${id}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { id },
  );
}

describe('POST /api/knowledge/proposals/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 400 when decision is missing', async () => {
    const res = await decide('p1', {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_decision');
  });

  it('returns 400 when decision is invalid', async () => {
    const res = await decide('p1', { decision: 'maybe' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_decision');
  });

  it('accepts a pending propose_new proposal', async () => {
    await seedKnowledge('seed:wenyan:shici');
    await seedProposeEvent({
      id: 'p1',
      name: '通假字',
      parent_id: 'seed:wenyan:shici',
      reasoning: 'r',
    });

    const res = await decide('p1', { decision: 'accept' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('propose_new_applied');

    const db = testDb();
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p1')));
    expect(rateRows).toHaveLength(1);
    expect((rateRows[0].payload as Record<string, unknown>).rating).toBe('accept');
  });

  it('dismisses a pending proposal when decision=reject', async () => {
    await seedKnowledge('parent_k');
    await seedProposeEvent({ id: 'p2', name: 'x', parent_id: 'parent_k' });

    const res = await decide('p2', { decision: 'reject' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('dismissed');

    const db = testDb();
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p2')));
    expect((rateRows[0].payload as Record<string, unknown>).rating).toBe('dismiss');
  });

  it('returns 404 for non-existent proposal', async () => {
    const res = await decide('nonexistent', { decision: 'accept' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('returns 409 when proposal is not pending', async () => {
    await seedKnowledge('parent_k');
    await seedProposeEvent({ id: 'p_already', name: 'X', parent_id: 'parent_k' });
    await seedRateEvent({ id: 'r_already', propose_event_id: 'p_already', rating: 'accept' });

    const res = await decide('p_already', { decision: 'accept' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_pending');
  });
});
