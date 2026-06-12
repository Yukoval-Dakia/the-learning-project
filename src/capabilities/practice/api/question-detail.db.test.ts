// YUK-280 P4 (YUK-203) — GET /api/questions/[id] route DB integration test.
//
// Auth is enforced upstream by middleware (not re-tested here); this exercises
// the 200 detail path, the 404 on missing id, and 400 timeline_limit validation.

import { newId } from '@/core/ids';
import { question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './question-detail';

const NOW = new Date('2026-06-07T00:00:00Z');

async function seedQuestion(id: string): Promise<void> {
  await testDb().insert(question).values({
    id,
    kind: 'reading',
    prompt_md: 'prompt',
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    created_at: NOW,
    updated_at: NOW,
  });
}

function mkReq(id: string, query = ''): Request {
  return new Request(`http://localhost/api/questions/${id}${query}`);
}

describe('GET /api/questions/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns the detail aggregate for an existing question', async () => {
    const id = newId();
    await seedQuestion(id);

    const res = await GET(mkReq(id), { id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      source_tier: { tier: number; name: string };
      scheduling: unknown;
      backlinks: unknown[];
      computed_at_sec: number;
    };
    expect(body.id).toBe(id);
    expect(body.source_tier).toEqual({ tier: 4, name: 'generated' });
    expect(Array.isArray(body.backlinks)).toBe(true);
    expect(typeof body.computed_at_sec).toBe('number');
  });

  it('404s on a missing question', async () => {
    const res = await GET(mkReq('q_nope'), { id: 'q_nope' });
    expect(res.status).toBe(404);
  });

  it('rejects an invalid timeline_limit with 400', async () => {
    const id = newId();
    await seedQuestion(id);
    const res = await GET(mkReq(id, '?timeline_limit=abc'), { id });
    expect(res.status).toBe(400);
  });

  it('rejects partial-numeric timeline_limit with 400 (parseInt leniency)', async () => {
    // P3 regression (coderabbit-route-34-timeline-limit-parseint): Number.parseInt
    // accepts '10abc' → 10 and '1.5' → 1; the strict /^[1-9]\d*$/ guard must reject
    // both rather than silently coercing.
    const id = newId();
    await seedQuestion(id);
    for (const raw of ['10abc', '1.5', '0', '-1', ' 10']) {
      const res = await GET(mkReq(id, `?timeline_limit=${encodeURIComponent(raw)}`), { id });
      expect(res.status).toBe(400);
    }
  });
});
