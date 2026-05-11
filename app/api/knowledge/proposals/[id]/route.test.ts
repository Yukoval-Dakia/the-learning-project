import { dreaming_proposal, knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { POST } from './route';

const KNOWLEDGE_BASE = {
  base_mastery: 0 as const,
  ai_delta_mastery: 0 as const,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function decide(id: string, body: unknown) {
  return POST(
    new Request(`http://localhost/api/knowledge/proposals/${id}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
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
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'seed:wenyan:shici',
      name: '诗词',
      domain: 'wenyan',
      parent_id: null,
      archived_at: null,
      ...KNOWLEDGE_BASE,
      created_at: now,
      updated_at: now,
    });
    await db.insert(dreaming_proposal).values({
      id: 'p1',
      kind: 'knowledge',
      payload: {
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      } as Record<string, unknown>,
      reasoning: 'r',
      status: 'pending',
      proposed_at: now,
      decided_at: null,
    });

    const res = await decide('p1', { decision: 'accept' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('propose_new_applied');
  });

  it('dismisses a pending proposal when decision=reject', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(dreaming_proposal).values({
      id: 'p2',
      kind: 'knowledge',
      payload: {
        mutation: 'propose_new',
        name: 'x',
        parent_id: null,
      } as Record<string, unknown>,
      reasoning: 'r',
      status: 'pending',
      proposed_at: now,
      decided_at: null,
    });

    const res = await decide('p2', { decision: 'reject' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('dismissed');
  });

  it('returns 404 for non-existent proposal', async () => {
    const res = await decide('nonexistent', { decision: 'accept' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('returns 409 when proposal is not pending', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'parent_k',
      name: '诗词',
      domain: 'wenyan',
      parent_id: null,
      archived_at: null,
      ...KNOWLEDGE_BASE,
      created_at: now,
      updated_at: now,
    });
    await db.insert(dreaming_proposal).values({
      id: 'p_already',
      kind: 'knowledge',
      payload: {
        mutation: 'propose_new',
        name: 'X',
        parent_id: 'parent_k',
      } as Record<string, unknown>,
      reasoning: 'r',
      status: 'accepted',
      proposed_at: now,
      decided_at: now,
    });

    const res = await decide('p_already', { decision: 'accept' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_pending');
  });
});
