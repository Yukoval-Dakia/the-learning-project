import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './tree';

const KNOWLEDGE_BASE = {
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function getKnowledge() {
  return GET();
}

describe('GET /api/knowledge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty rows when no knowledge nodes exist', async () => {
    const res = await getKnowledge();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(0);
  });

  it('returns full tree with effective_domain pre-computed', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'k1',
        name: '虚词',
        domain: 'wenyan',
        parent_id: null,
        archived_at: null,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'k2',
        name: '之',
        domain: null,
        parent_id: 'k1',
        archived_at: null,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      },
    ]);

    const res = await getKnowledge();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; effective_domain: string }> };
    expect(body.rows).toHaveLength(2);
    const k1 = body.rows.find((r) => r.id === 'k1');
    const k2 = body.rows.find((r) => r.id === 'k2');
    expect(k1?.effective_domain).toBe('wenyan');
    expect(k2?.effective_domain).toBe('wenyan');
  });

  it('excludes archived nodes', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'k1',
        name: '活跃',
        domain: 'wenyan',
        parent_id: null,
        archived_at: null,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'k2',
        name: '归档',
        domain: null,
        parent_id: 'k1',
        archived_at: now,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      },
    ]);

    const res = await getKnowledge();
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('k1');
  });
});
