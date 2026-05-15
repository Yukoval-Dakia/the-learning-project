import { dreaming_proposal, knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

const KNOWLEDGE_BASE = {
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

const PROPOSAL_BASE = {
  kind: 'knowledge' as const,
  payload: { mutation: 'propose_new', name: 'X', parent_id: null } as Record<string, unknown>,
  reasoning: 'test',
};

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

  it('returns pending proposals by default', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(dreaming_proposal).values([
      {
        id: 'p1',
        ...PROPOSAL_BASE,
        status: 'pending',
        proposed_at: now,
        decided_at: null,
      },
      {
        id: 'p2',
        ...PROPOSAL_BASE,
        status: 'accepted',
        proposed_at: now,
        decided_at: now,
      },
    ]);

    const res = await getProposals();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; status: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('p1');
    expect(body.rows[0].status).toBe('pending');
  });

  it('returns accepted proposals when status=accepted query param is passed', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(dreaming_proposal).values([
      {
        id: 'p1',
        ...PROPOSAL_BASE,
        status: 'pending',
        proposed_at: now,
        decided_at: null,
      },
      {
        id: 'p2',
        ...PROPOSAL_BASE,
        status: 'accepted',
        proposed_at: now,
        decided_at: now,
      },
    ]);

    const res = await getProposals('status=accepted');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; status: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('p2');
  });

  it('returns empty array when no proposals match', async () => {
    const res = await getProposals();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(0);
  });
});
