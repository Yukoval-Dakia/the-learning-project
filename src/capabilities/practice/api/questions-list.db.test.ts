// YUK-280 P4 (YUK-203) — GET /api/questions route DB integration test.
//
// Auth is enforced upstream by middleware (not re-tested here — see middleware
// tests); this exercises the 200 query path + 400 validation + the response
// envelope ({ items, families, total, truncated, computed_at_sec }).

import { newId } from '@/core/ids';
import { knowledge, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './questions-list';

async function seedKnowledge(id: string, domain: string): Promise<string> {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: `node ${id}`,
      domain,
      created_at: new Date(),
      updated_at: new Date(),
    });
  return id;
}

async function seedQuestion(opts: {
  id?: string;
  source?: string;
  kind?: string;
  difficulty?: number;
  knowledge_ids?: string[];
  draft_status?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: Date;
}): Promise<string> {
  const id = opts.id ?? newId();
  const now = opts.created_at ?? new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      kind: opts.kind ?? 'reading',
      prompt_md: 'prompt',
      knowledge_ids: opts.knowledge_ids ?? [],
      difficulty: opts.difficulty ?? 3,
      source: opts.source ?? 'manual',
      draft_status: opts.draft_status ?? null,
      metadata: (opts.metadata ?? null) as never,
      created_at: now,
      updated_at: now,
    });
  return id;
}

function mkReq(query = ''): Request {
  return new Request(`http://localhost/api/questions${query}`);
}

interface ListBody {
  items: Array<{ id: string; source_tier: { tier: number; name: string } }>;
  families: Array<{ root_question_id: string; variant_count: number }> | null;
  total: number;
  truncated: boolean;
  computed_at_sec: number;
}

describe('GET /api/questions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns the list envelope with numeric total/computed_at_sec', async () => {
    await seedQuestion({ source: 'manual' });
    await seedQuestion({ source: 'web_sourced' });

    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(2);
    expect(body.families).toBeNull();
    expect(typeof body.total).toBe('number');
    expect(typeof body.computed_at_sec).toBe('number');
    expect(body.truncated).toBe(false);
  });

  it('filters by source query param', async () => {
    await seedQuestion({ source: 'manual' });
    await seedQuestion({ source: 'web_sourced' });

    const res = await GET(mkReq('?source=web_sourced'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(1);
  });

  it('accepts repeated knowledge_id params (OR match)', async () => {
    const k1 = newId();
    const k2 = newId();
    await seedQuestion({ knowledge_ids: [k1] });
    await seedQuestion({ knowledge_ids: [k2] });
    await seedQuestion({ knowledge_ids: [newId()] });

    const res = await GET(mkReq(`?knowledge_id=${k1}&knowledge_id=${k2}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(2);
  });

  it('returns source_tier sorted result via sort_by=source_tier', async () => {
    const t1 = await seedQuestion({
      source: 'vision_paper',
      metadata: { ingestion_session_id: 's1' },
      created_at: new Date('2026-05-01T00:00:00Z'),
    });
    const t4 = await seedQuestion({
      source: 'manual',
      metadata: null,
      created_at: new Date('2026-05-02T00:00:00Z'),
    });

    const res = await GET(mkReq('?sort_by=source_tier'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items.map((i) => i.id)).toEqual([t1, t4]);
    expect(body.items[0].source_tier).toEqual({ tier: 1, name: 'authentic' });
  });

  it('returns families with group_by_family=1', async () => {
    const root = newId();
    await seedQuestion({ id: root });
    await seedQuestion({ source: 'manual', metadata: null });

    const res = await GET(mkReq('?group_by_family=1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.families).not.toBeNull();
    expect(body.total).toBe(2);
  });

  it('filters by subject query param (derived knowledge join)', async () => {
    const wenyanK = await seedKnowledge(newId(), 'wenyan');
    const mathK = await seedKnowledge(newId(), 'math');
    const qWenyan = await seedQuestion({ knowledge_ids: [wenyanK] });
    await seedQuestion({ knowledge_ids: [mathK] });

    const res = await GET(mkReq('?subject=wenyan'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(1);
    expect(body.items.map((i) => i.id)).toEqual([qWenyan]);
  });

  it('returns empty for a subject that labels no questions', async () => {
    await seedQuestion({ knowledge_ids: [await seedKnowledge(newId(), 'wenyan')] });
    const res = await GET(mkReq('?subject=does-not-exist'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(0);
  });

  it('rejects invalid difficulty with 400', async () => {
    const res = await GET(mkReq('?difficulty=9'));
    expect(res.status).toBe(400);
  });

  it('rejects mutually-exclusive expand_root + group_by_family with 400', async () => {
    const res = await GET(mkReq('?expand_root=abc&group_by_family=1'));
    expect(res.status).toBe(400);
  });
});
