// T-RA — pre-submit RatingAdvisor preview route (YUK-98).
//
// This endpoint must not write review events or mutate FSRS state. It exists so
// `/review` can show advisory before the user commits a rating.

import { event, material_fsrs_state, question } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
// YUK-101 (iter2 fix F12) — shared seeders from tests/helpers/event-seed.
// Iter1 duplicated these byte-for-byte in advice + submit test files; the
// helper also adds the paired learning_record(kind='mistake') mirror that
// every other test in the repo creates alongside failure attempts.
import { seedAttempt, seedUserCause } from '../../../../tests/helpers/event-seed';
import { POST } from './advice';

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

  // YUK-100 (W-05) — Cause wiring fix. Driver T-RA §1.1 says partial-credit
  // advisor must lean toward 'good' when effective cause is carelessness-like
  // and toward 'again' when it's conceptual-like, sourced via CC-1's
  // effectiveCauseCategoryForFailureAttempt() helper. Pre-fix the advice route
  // never threaded cause into the advisor, so the lean was dead code in
  // production. These tests pin the wiring at the route layer.
  describe('YUK-100 — partial-credit cause lean (W-05 wiring)', () => {
    it('applies carelessness lean when cause=carelessness on prior failure attempt', async () => {
      // partial-credit keyword judge with prior carelessness user_cause should
      // promote 'hard' default → 'good' per driver T-RA §1.1.
      await seedQuestion('q_advice_careless', {
        kind: 'fill_blank',
        reference_md: '虚词；代词；连词',
        judge_kind_override: 'keyword',
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: '命中关键词' }],
          keywords: ['虚词', '代词', '连词'],
        },
      });
      await seedAttempt({
        id: 'a_advice_careless',
        question_id: 'q_advice_careless',
        answer_md: 'old wrong',
      });
      await seedUserCause({
        id: 'uc_advice_careless',
        attempt_event_id: 'a_advice_careless',
        primary_category: 'carelessness',
      });

      const res = await POST(
        adviceReq({
          activity_ref: { kind: 'question', id: 'q_advice_careless' },
          response_md: '虚词和代词',
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        judge: { route: string; coarse_outcome: string };
        advice: { rating: string | null; reason: string };
      };
      expect(body.judge.route).toBe('keyword');
      expect(body.judge.coarse_outcome).toBe('partial');
      expect(body.advice.rating).toBe('good');
      expect(body.advice.reason).toMatch(/careless|carelessness/i);
    });

    it('applies conceptual lean when cause=conceptual_error on prior failure attempt', async () => {
      // partial-credit keyword judge with prior conceptual_error user_cause
      // should demote 'hard' default → 'again' per driver T-RA §1.1.
      await seedQuestion('q_advice_concept', {
        kind: 'fill_blank',
        reference_md: '虚词；代词；连词',
        judge_kind_override: 'keyword',
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: '命中关键词' }],
          keywords: ['虚词', '代词', '连词'],
        },
      });
      await seedAttempt({
        id: 'a_advice_concept',
        question_id: 'q_advice_concept',
        answer_md: 'old wrong',
      });
      await seedUserCause({
        id: 'uc_advice_concept',
        attempt_event_id: 'a_advice_concept',
        primary_category: 'conceptual_error',
      });

      const res = await POST(
        adviceReq({
          activity_ref: { kind: 'question', id: 'q_advice_concept' },
          response_md: '虚词和代词',
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        judge: { route: string; coarse_outcome: string };
        advice: { rating: string | null; reason: string };
      };
      expect(body.judge.route).toBe('keyword');
      expect(body.judge.coarse_outcome).toBe('partial');
      expect(body.advice.rating).toBe('again');
      expect(body.advice.reason).toMatch(/concept|conceptual/i);
    });

    it('falls back to default partial-credit bucket when no prior failure attempt exists', async () => {
      // Sanity: no cause history → advisor keeps default partial-credit bucket
      // (this is the legal fallback for `causeCategory = null`).
      await seedQuestion('q_advice_nocause', {
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
          activity_ref: { kind: 'question', id: 'q_advice_nocause' },
          response_md: '虚词和代词',
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        judge: { coarse_outcome: string };
        advice: { rating: string | null; reason: string };
      };
      expect(body.judge.coarse_outcome).toBe('partial');
      // Default partial bucket for score ≥ 0.5 is 'hard' — no lean applied.
      expect(body.advice.rating).toBe('hard');
      expect(body.advice.reason).not.toMatch(/careless|conceptual/i);
    });
  });
});
