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

async function seedKnowledge(id: string, domain: string, name = `node ${id}`): Promise<string> {
  await testDb().insert(knowledge).values({
    id,
    name,
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
  prompt_md?: string;
  created_at?: Date;
}): Promise<string> {
  const id = opts.id ?? newId();
  const now = opts.created_at ?? new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      kind: opts.kind ?? 'reading',
      prompt_md: opts.prompt_md ?? 'prompt',
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
  page: { limit: number; offset: number; has_more: boolean };
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

  it('returns explicit page truth and stable progressive offsets', async () => {
    for (let i = 0; i < 25; i += 1) {
      await seedQuestion({ created_at: new Date(1_700_000_000_000 + i * 1_000) });
    }

    const first = (await (await GET(mkReq('?limit=10&offset=0'))).json()) as ListBody;
    expect(first.total).toBe(25);
    expect(first.items).toHaveLength(10);
    expect(first.page).toEqual({ limit: 10, offset: 0, has_more: true });

    const last = (await (await GET(mkReq('?limit=10&offset=20'))).json()) as ListBody;
    expect(last.items).toHaveLength(5);
    expect(last.page).toEqual({ limit: 10, offset: 20, has_more: false });
  });

  it('applies repeated difficulty and status filters before pagination', async () => {
    const active2 = await seedQuestion({ difficulty: 2 });
    const active5 = await seedQuestion({ difficulty: 5 });
    await seedQuestion({ difficulty: 4, draft_status: 'draft' });

    const active = (await (
      await GET(mkReq('?include_drafts=1&status=active&difficulty=2&difficulty=5&limit=1'))
    ).json()) as ListBody;
    expect(active.total).toBe(2);
    expect(active.items).toHaveLength(1);
    expect(active.page.has_more).toBe(true);
    expect([active2, active5]).toContain(active.items[0].id);

    const drafts = (await (await GET(mkReq('?include_drafts=1&status=draft'))).json()) as ListBody;
    expect(drafts.total).toBe(1);

    const all = (await (await GET(mkReq('?status=all'))).json()) as ListBody;
    expect(all.total).toBe(3);
  });

  it('searches full prompt and knowledge name, then sorts difficulty server-side', async () => {
    const knowledgeId = await seedKnowledge(newId(), 'yuwen', '劝学实词');
    const hard = await seedQuestion({
      difficulty: 5,
      prompt_md: '另一道题',
      knowledge_ids: [knowledgeId],
      created_at: new Date('2026-05-01T00:00:00Z'),
    });
    const easy = await seedQuestion({
      difficulty: 1,
      prompt_md: '劝学原文理解',
      created_at: new Date('2026-05-02T00:00:00Z'),
    });
    await seedQuestion({ difficulty: 3, prompt_md: '无关题目' });

    const body = (await (
      await GET(mkReq('?search=%E5%8A%9D%E5%AD%A6&sort_by=difficulty&sort_dir=asc'))
    ).json()) as ListBody;
    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.id)).toEqual([easy, hard]);
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
    const yuwenK = await seedKnowledge(newId(), 'yuwen');
    const mathK = await seedKnowledge(newId(), 'math');
    const qYuwen = await seedQuestion({ knowledge_ids: [yuwenK] });
    await seedQuestion({ knowledge_ids: [mathK] });

    const res = await GET(mkReq('?subject=yuwen'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(1);
    expect(body.items.map((i) => i.id)).toEqual([qYuwen]);
  });

  it('returns empty for a subject that labels no questions', async () => {
    await seedQuestion({ knowledge_ids: [await seedKnowledge(newId(), 'yuwen')] });
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
