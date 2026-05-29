// YUK-96 P6/C — GET /api/knowledge/[id] route test.
//
// Verifies the single-node endpoint: 404 for unknown / archived nodes,
// 200 with aggregated page data for valid nodes.

import { artifact, knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

const K_BASE = {
  domain: 'wenyan' as const,
  parent_id: null as null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

const A_BASE = {
  intent_source: 'test',
  source: 'test',
  verification_status: 'not_required',
  embedded_check_status: 'not_required',
};

async function getNode(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/knowledge/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/knowledge/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 404 for unknown knowledge id', async () => {
    const res = await getNode('does_not_exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('returns 404 for archived knowledge node', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k-arch',
      name: 'archived',
      archived_at: now,
      created_at: now,
      updated_at: now,
      ...K_BASE,
    });
    const res = await getNode('k-arch');
    expect(res.status).toBe(404);
  });

  it('returns 200 with node page data for a valid node', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k1',
      name: '虚词',
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...K_BASE,
    });
    const res = await getNode('k1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      primary_atomic: unknown;
      mesh_neighbors: unknown[];
      backlinks: unknown[];
      timeline: unknown[];
    };
    expect(body.id).toBe('k1');
    expect(body.name).toBe('虚词');
    expect(body.primary_atomic).toBeNull();
    expect(body.mesh_neighbors).toEqual([]);
    expect(body.backlinks).toEqual([]);
    expect(body.timeline).toEqual([]);
  });

  it('returns primary_atomic when an atomic artifact is present', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k2',
      name: '之',
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...K_BASE,
    });
    await db.insert(artifact).values({
      id: 'a1',
      type: 'note_atomic',
      title: '之-atomic',
      knowledge_ids: ['k2'],
      body_blocks: { type: 'doc', content: [] } as never,
      generation_status: 'ready',
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...A_BASE,
    });
    const res = await getNode('k2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { primary_atomic: { id: string; title: string } | null };
    expect(body.primary_atomic).not.toBeNull();
    expect(body.primary_atomic?.id).toBe('a1');
    expect(body.primary_atomic?.title).toBe('之-atomic');
  });
});
