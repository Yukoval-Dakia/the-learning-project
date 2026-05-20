// POST /api/embedded-check/attempt
// Tests for the embedded check attempt endpoint.

import { event, learning_record, material_fsrs_state, question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './route';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const QUESTION_BASE = {
  kind: 'fill_blank' as const,
  // short_answer with reference_md allows the exact judge to run deterministically
  reference_md: '答案',
  knowledge_ids: [] as string[],
  difficulty: 3,
  variant_depth: 0,
  version: 0,
};

async function seedEmbeddedQuestion(
  id = 'q1',
  overrides: Partial<typeof question.$inferInsert> = {},
) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    prompt_md: '填空题',
    source: 'embedded',
    created_at: now,
    updated_at: now,
    ...QUESTION_BASE,
    ...overrides,
  });
}

async function postAttempt(body: unknown) {
  return POST(
    new Request('http://localhost/api/embedded-check/attempt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('POST /api/embedded-check/attempt', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Test 1: Happy path correct
  it('correct answer → outcome=success, attempt event written, no learning_record', async () => {
    await seedEmbeddedQuestion('q1', { reference_md: '答案' });

    const res = await postAttempt({ question_id: 'q1', answer_md: '答案' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      outcome: string;
      judge: { route: string; score: number };
      mistake_id?: string;
    };
    expect(body.outcome).toBe('success');
    expect(body.judge).toBeDefined();
    expect(body.mistake_id).toBeUndefined();

    const db = testDb();
    const events = await db.select().from(event).where(eq(event.subject_id, 'q1'));
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('attempt');
    expect(events[0].outcome).toBe('success');

    const records = await db.select().from(learning_record);
    expect(records).toHaveLength(0);
  });

  // Test 2: Happy path wrong
  it('wrong answer → outcome=failure, attempt event + learning_record(kind=mistake)', async () => {
    await seedEmbeddedQuestion('q1', { reference_md: '答案' });

    const res = await postAttempt({ question_id: 'q1', answer_md: '错' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      outcome: string;
      judge: { route: string; score: number };
      mistake_id: string;
    };
    expect(body.outcome).toBe('failure');
    expect(body.mistake_id).toBeTruthy();

    const db = testDb();

    const events = await db.select().from(event).where(eq(event.subject_id, 'q1'));
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('attempt');
    expect(events[0].outcome).toBe('failure');

    const records = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.question_id, 'q1'));
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(body.mistake_id);
    expect(records[0].kind).toBe('mistake');
    expect(records[0].question_id).toBe('q1');
    expect(records[0].attempt_event_id).toBe(events[0].id);
    expect((records[0].payload as Record<string, unknown>).from).toBe('embedded_check');
  });

  // Test 3: 422 on non-embedded question
  it('returns 422 when question source is not embedded', async () => {
    await seedEmbeddedQuestion('q1', { source: 'daily' });

    const res = await postAttempt({ question_id: 'q1', answer_md: '答案' });
    expect(res.status).toBe(422);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('question_not_embedded');
  });

  // Test 4: 404 on missing question
  it('returns 404 when question does not exist', async () => {
    const res = await postAttempt({ question_id: 'q_missing', answer_md: '答案' });
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  // Test 5: 400 on missing/invalid body fields
  it('returns 400 when question_id is missing', async () => {
    const res = await postAttempt({ answer_md: '答案' });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 when answer_md is missing', async () => {
    const res = await postAttempt({ question_id: 'q1' });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 on empty body', async () => {
    const res = POST(
      new Request('http://localhost/api/embedded-check/attempt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    const response = await res;
    expect(response.status).toBe(400);
  });

  // Test 6: Auth — middleware enforces x-internal-token globally; route tests
  // assume auth has already passed (same pattern as learning-items/[id]/route.test.ts
  // which doesn't test middleware auth in the route test file). No per-route auth
  // assertion needed here.

  // Test 7: Idempotency — second attempt writes a second event + second learning_record
  it('second wrong attempt creates a second event row and second learning_record', async () => {
    await seedEmbeddedQuestion('q1', { reference_md: '答案' });

    await postAttempt({ question_id: 'q1', answer_md: '错1' });
    await postAttempt({ question_id: 'q1', answer_md: '错2' });

    const db = testDb();

    const events = await db.select().from(event).where(eq(event.subject_id, 'q1'));
    expect(events).toHaveLength(2);

    const records = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.question_id, 'q1'));
    expect(records).toHaveLength(2);
  });

  // Test 8: FSRS untouched
  it('does not write material_fsrs_state rows', async () => {
    await seedEmbeddedQuestion('q1', { reference_md: '答案' });

    const db = testDb();

    const countBefore = await db.select().from(material_fsrs_state);

    // both correct and incorrect attempt
    await postAttempt({ question_id: 'q1', answer_md: '答案' });
    await postAttempt({ question_id: 'q1', answer_md: '错' });

    const countAfter = await db.select().from(material_fsrs_state);
    expect(countAfter.length).toBe(countBefore.length);
  });
});
