import { mistake, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

const QUESTION_BASE = {
  kind: 'short_answer',
  reference_md: null,
  knowledge_ids: ['k1'],
  difficulty: 3,
  source: 'manual' as const,
  variant_depth: 0,
  version: 0,
};

const MISTAKE_BASE = {
  source: 'manual' as const,
  knowledge_ids: ['k1'],
  wrong_answer_image_refs: [],
  variants: [],
  variants_generated_count: 0,
  variants_max: 3,
  status: 'active' as const,
  version: 0,
};

describe('GET /api/mistakes/recent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns recent mistakes with prompt + wrong answer + cause, truncated at 200', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values({
      id: 'q1',
      prompt_md: 'P'.repeat(300),
      created_at: now,
      updated_at: now,
      ...QUESTION_BASE,
    });
    await db.insert(mistake).values({
      id: 'm1',
      question_id: 'q1',
      wrong_answer_md: 'W'.repeat(300),
      cause: {
        primary_category: 'concept',
        secondary_categories: [],
        ai_analysis_md: 'a',
        user_edited: false,
      },
      created_at: now,
      updated_at: now,
      ...MISTAKE_BASE,
    });

    const res = await GET(new Request('http://localhost/api/mistakes/recent'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; prompt_md: string; cause: unknown }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('m1');
    expect(body.rows[0].prompt_md).toHaveLength(200);
    expect((body.rows[0].cause as { primary_category: string }).primary_category).toBe('concept');
  });

  it('passes null cause through', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values({
      id: 'q2',
      prompt_md: 'p',
      created_at: now,
      updated_at: now,
      ...QUESTION_BASE,
    });
    await db.insert(mistake).values({
      id: 'm2',
      question_id: 'q2',
      wrong_answer_md: 'w',
      cause: null,
      created_at: now,
      updated_at: now,
      ...MISTAKE_BASE,
    });

    const res = await GET(new Request('http://localhost/api/mistakes/recent'));
    const body = (await res.json()) as { rows: Array<{ cause: unknown }> };
    expect(body.rows[0].cause).toBeNull();
  });

  it('respects limit query param', async () => {
    const db = testDb();
    const now = new Date();
    // Insert 5 questions + mistakes
    for (let i = 1; i <= 5; i++) {
      await db.insert(question).values({
        id: `q${i}`,
        prompt_md: `Question ${i}`,
        created_at: new Date(now.getTime() + i * 1000),
        updated_at: now,
        ...QUESTION_BASE,
      });
      await db.insert(mistake).values({
        id: `m${i}`,
        question_id: `q${i}`,
        wrong_answer_md: `w${i}`,
        cause: null,
        created_at: new Date(now.getTime() + i * 1000),
        updated_at: now,
        ...MISTAKE_BASE,
      });
    }

    const res = await GET(new Request('http://localhost/api/mistakes/recent?limit=3'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(3);
  });

  it('clamps limit > 100 to 100', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values({
      id: 'q1',
      prompt_md: 'p',
      created_at: now,
      updated_at: now,
      ...QUESTION_BASE,
    });
    await db.insert(mistake).values({
      id: 'm1',
      question_id: 'q1',
      wrong_answer_md: 'w',
      cause: null,
      created_at: now,
      updated_at: now,
      ...MISTAKE_BASE,
    });

    const res = await GET(new Request('http://localhost/api/mistakes/recent?limit=999'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1); // only 1 row inserted, limit clamped to 100
  });

  it('excludes archived and deleted mistakes', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values({
      id: 'q1',
      prompt_md: 'p',
      created_at: now,
      updated_at: now,
      ...QUESTION_BASE,
    });
    await db.insert(mistake).values({
      id: 'm1',
      question_id: 'q1',
      wrong_answer_md: 'w',
      cause: null,
      archived_at: now,
      created_at: now,
      updated_at: now,
      ...MISTAKE_BASE,
    });

    const res = await GET(new Request('http://localhost/api/mistakes/recent'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(0);
  });
});
