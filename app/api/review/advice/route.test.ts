// T-RA — pre-submit RatingAdvisor preview route (YUK-98).
//
// This endpoint must not write review events or mutate FSRS state. It exists so
// `/review` can show advisory before the user commits a rating.

import { event, material_fsrs_state, question } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './route';

const QUESTION_BASE = {
  kind: 'short_answer' as const,
  reference_md: null,
  knowledge_ids: [] as string[],
  difficulty: 3,
  source: 'manual' as const,
  variant_depth: 0,
  version: 0,
};

async function seedQuestion(id: string, overrides: Partial<typeof question.$inferInsert> = {}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    prompt_md: `Prompt for ${id}`,
    created_at: now,
    updated_at: now,
    ...QUESTION_BASE,
    ...overrides,
  });
}

function adviceReq(body: unknown) {
  return new Request('http://localhost/api/review/advice', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/review/advice', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns exact judge + rating advice without writing review event or FSRS state', async () => {
    await seedQuestion('q_advice_exact', {
      kind: 'fill_blank',
      reference_md: '答案',
    });

    const res = await POST(
      adviceReq({
        activity_ref: { kind: 'question', id: 'q_advice_exact' },
        response_md: '答案',
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      question_id: string;
      judge: {
        route: string;
        score_meaning: string;
        coarse_outcome: string;
        suggested_rating: string | null;
      };
      advice: { rating: string | null; evidence_score: number | null; reason: string };
    };
    expect(body.question_id).toBe('q_advice_exact');
    expect(body.judge.route).toBe('exact');
    expect(body.judge.score_meaning).toBe('correctness');
    expect(body.judge.coarse_outcome).toBe('correct');
    expect(body.judge.suggested_rating).toBe('good');
    expect(body.advice.rating).toBe('good');

    const events = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q_advice_exact')));
    expect(events).toHaveLength(0);
    const stateRows = await testDb()
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'q_advice_exact'));
    expect(stateRows).toHaveLength(0);
  });

  it('returns partial keyword advice as hard before final user rating', async () => {
    await seedQuestion('q_advice_keyword', {
      kind: 'fill_blank',
      reference_md: '虚词；代词；连词',
      judge_kind_override: 'keyword',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '命中关键词' }],
        keywords: ['虚词', '代词', '连词'],
      },
    });

    const res = await POST(
      adviceReq({
        activity_ref: { kind: 'question', id: 'q_advice_keyword' },
        response_md: '虚词和代词',
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      judge: { route: string; coarse_outcome: string };
      advice: { rating: string | null; evidence_score: number | null; reason: string };
    };
    expect(body.judge.route).toBe('keyword');
    expect(body.judge.coarse_outcome).toBe('partial');
    expect(body.advice.rating).toBe('hard');
    expect(body.advice.evidence_score).toBeGreaterThanOrEqual(0.5);
    expect(body.advice.reason).toMatch(/partial/i);
  });

  it('rejects empty response_md because advice requires an answer to judge', async () => {
    await seedQuestion('q_advice_empty', {
      kind: 'fill_blank',
      reference_md: '答案',
    });

    const res = await POST(
      adviceReq({
        activity_ref: { kind: 'question', id: 'q_advice_empty' },
        response_md: '   ',
      }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('missing_answer');
    expect(body.message).toContain('response_md');
  });
});
