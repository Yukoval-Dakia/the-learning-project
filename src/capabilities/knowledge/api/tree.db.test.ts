import { beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeTreeResponseSchema } from '@/capabilities/knowledge/api/contracts';
import { knowledge } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './tree';

const KNOWLEDGE_BASE = {
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function getKnowledge(query = '') {
  return GET(new Request(`http://localhost/api/knowledge${query}`));
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
        domain: 'yuwen',
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
    const json = await res.json();
    KnowledgeTreeResponseSchema.parse(json);
    const body = json as { rows: Array<{ id: string; effective_domain: string }> };
    expect(body.rows).toHaveLength(2);
    const k1 = body.rows.find((r) => r.id === 'k1');
    const k2 = body.rows.find((r) => r.id === 'k2');
    expect(k1?.effective_domain).toBe('yuwen');
    expect(k2?.effective_domain).toBe('yuwen');
  });

  it('excludes synthetic:* rows from the learner tree (YUK-897)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'k1',
        name: '实词',
        domain: 'yuwen',
        parent_id: null,
        archived_at: null,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'synthetic:yuwen:0001',
        name: '种子节点',
        domain: 'yuwen',
        parent_id: null,
        archived_at: null,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      },
    ]);

    const res = await getKnowledge();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('k1');
  });

  it('excludes all known fixture namespaces from the learner tree (YUK-897 E1)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'k_visible',
        name: '真实节点',
        domain: 'yuwen',
        parent_id: null,
        archived_at: null,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      },
      ...[
        'kc_yuk792_canary_20260731a',
        'kc_yuk792_canary_20260731b',
        'kc_yuk792_canary_20260731c',
        'synthetic:yuwen:fixture',
      ].map((id) => ({
        id,
        name: `fixture ${id}`,
        domain: 'yuwen',
        parent_id: null,
        archived_at: null,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      })),
    ]);

    const res = await getKnowledge();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((row) => row.id)).toEqual(['k_visible']);
    expect(JSON.stringify(body)).not.toContain('kc_yuk792_canary_20260731');
    expect(JSON.stringify(body)).not.toContain('synthetic:');
  });

  it('excludes archived nodes', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'k1',
        name: '活跃',
        domain: 'yuwen',
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

  it('filters by effective subject while retaining the subject container root', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'seed:yuwen:root',
        name: '语文',
        domain: 'yuwen',
        parent_id: null,
        archived_at: null,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'yuwen-child',
        name: '虚词',
        domain: null,
        parent_id: 'seed:yuwen:root',
        archived_at: null,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'seed:math:root',
        name: '数学',
        domain: 'math',
        parent_id: null,
        archived_at: null,
        ...KNOWLEDGE_BASE,
        created_at: now,
        updated_at: now,
      },
    ]);

    const res = await getKnowledge('?subject=yuwen');
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((row) => row.id)).toEqual(['seed:yuwen:root', 'yuwen-child']);
  });
});
