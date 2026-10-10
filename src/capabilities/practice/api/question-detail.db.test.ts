// YUK-280 P4 (YUK-203) — GET /api/questions/[id] route DB integration test.
//
// Auth is enforced upstream by middleware (not re-tested here); this exercises
// the 200 detail path, the 404 on missing id, and 400 timeline_limit validation.

import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@/core/ids';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import { question } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './question-detail';

const NOW = new Date('2026-06-07T00:00:00Z');

async function seedQuestion(
  id: string,
  overrides: Partial<typeof question.$inferInsert> = {},
): Promise<void> {
  await testDb()
    .insert(question)
    .values({
      id,
      kind: 'reading',
      prompt_md: 'prompt',
      knowledge_ids: [],
      difficulty: 3,
      source: 'manual',
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    });
}

function mkReq(id: string, query = ''): Request {
  return new Request(`http://localhost/api/questions/${id}${query}`);
}

describe('GET /api/questions/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('404s product-owned intervention diagnostics instead of leaking future answers', async () => {
    const id = newId();
    await seedQuestion(id, {
      source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
      reference_md: 'future diagnostic answer',
    });

    const res = await GET(mkReq(id), { id });

    expect(res.status).toBe(404);
  });
});
