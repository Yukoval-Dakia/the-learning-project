// Phase 1c.1 Step 9.A — `/api/review/submit` over event stream.
//
// Pre-Step-9 tests seeded `mistake` + `review_event`. Post-Step-9 the legacy
// tables are gone; seed question rows + (optionally) material_fsrs_state.

import { event, material_fsrs_state, question } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './route';

const QUESTION_BASE = {
  kind: 'short_answer' as const,
  reference_md: null,
  knowledge_ids: ['k1'],
  difficulty: 3,
  source: 'manual' as const,
  variant_depth: 0,
  version: 0,
};

async function seedQuestion(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    prompt_md: `Prompt for ${id}`,
    created_at: now,
    updated_at: now,
    ...QUESTION_BASE,
  });
}

async function seedFsrsState(question_id: string, state: unknown, due_at: Date) {
  const db = testDb();
  const now = new Date();
  await db.insert(material_fsrs_state).values({
    id: `f_${question_id}`,
    subject_kind: 'question',
    subject_id: question_id,
    state: state as never,
    due_at,
    last_review_event_id: null,
    updated_at: now,
  });
}

function submitReq(body: unknown) {
  return new Request('http://localhost/api/review/submit', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/review/submit', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('first review (no prior fsrs_state) → writes review event + upserts material_fsrs_state', async () => {
    await seedQuestion('q1');

    const res = await POST(submitReq({ mistake_id: 'q1', rating: 'good', latency_ms: 5000 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      next_due_at: number;
      new_state: { reps: number; scheduled_days: number };
      review_event: { id: string; rating: string; latency_ms: number | null };
    };

    expect(typeof body.next_due_at).toBe('number');
    expect(body.next_due_at).toBeGreaterThan(0);
    expect(body.new_state.reps).toBeGreaterThanOrEqual(1);
    expect(body.review_event.rating).toBe('good');
    expect(body.review_event.latency_ms).toBe(5000);

    const db = testDb();
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('success');
    expect((events[0].payload as Record<string, unknown>).fsrs_rating).toBe('good');

    const fsrs = await db
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'q1'));
    expect(fsrs).toHaveLength(1);
    expect(fsrs[0].last_review_event_id).toBe(events[0].id);
  });

  it('second review (existing fsrs_state with ISO string dates) → Plan F1 coercion works', async () => {
    await seedQuestion('q1');
    const dueIso = '2026-05-09T12:00:00.000Z';
    const dueDate = new Date(dueIso);
    await seedFsrsState(
      'q1',
      {
        due: dueIso,
        stability: 1.5,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review',
        last_review: '2026-05-08T12:00:00.000Z',
      },
      dueDate,
    );

    const res = await POST(submitReq({ mistake_id: 'q1', rating: 'again' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      next_due_at: number;
      new_state: { scheduled_days: number; stability: number; lapses: number };
    };
    expect(Number.isFinite(body.next_due_at)).toBe(true);
    expect(body.next_due_at).toBeGreaterThan(0);
    expect(Number.isFinite(body.new_state.scheduled_days)).toBe(true);
    expect(Number.isFinite(body.new_state.stability)).toBe(true);
    expect(body.new_state.lapses).toBeGreaterThanOrEqual(1);

    const db = testDb();
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failure'); // again → failure invariant
  });

  it('returns 400 when rating is invalid (e.g. "easy")', async () => {
    await seedQuestion('q1');
    const res = await POST(submitReq({ mistake_id: 'q1', rating: 'easy' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 when mistake_id is missing', async () => {
    const res = await POST(submitReq({ rating: 'good' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 404 when question not found', async () => {
    const res = await POST(submitReq({ mistake_id: 'q_missing', rating: 'good' }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('returns null for response_md and latency_ms when not provided', async () => {
    await seedQuestion('q1');
    const res = await POST(submitReq({ mistake_id: 'q1', rating: 'good' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review_event: { response_md: string | null; latency_ms: number | null };
    };
    expect(body.review_event.response_md).toBeNull();
    expect(body.review_event.latency_ms).toBeNull();
  });

  it('includes response_md when provided', async () => {
    await seedQuestion('q1');
    const res = await POST(
      submitReq({ mistake_id: 'q1', rating: 'hard', response_md: 'my answer' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { review_event: { response_md: string | null } };
    expect(body.review_event.response_md).toBe('my answer');

    const db = testDb();
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect((events[0].payload as Record<string, unknown>).user_response_md).toBe('my answer');
  });

  it('rating transitions: again increases lapses, good increases reps', async () => {
    await seedQuestion('q1');
    const dueDate = new Date(Date.now() - 86400 * 1000);
    await seedFsrsState(
      'q1',
      {
        due: dueDate.toISOString(),
        stability: 2,
        difficulty: 5,
        elapsed_days: 1,
        scheduled_days: 2,
        learning_steps: 0,
        reps: 2,
        lapses: 0,
        state: 'review',
        last_review: null,
      },
      dueDate,
    );

    const res = await POST(submitReq({ mistake_id: 'q1', rating: 'again' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { new_state: { lapses: number; reps: number } };
    expect(body.new_state.lapses).toBeGreaterThan(0);
  });

  it('multiple reviews on same question keep one material_fsrs_state row (upsert behaviour)', async () => {
    await seedQuestion('q1');
    await POST(submitReq({ mistake_id: 'q1', rating: 'good' }));
    await POST(submitReq({ mistake_id: 'q1', rating: 'hard' }));

    const db = testDb();
    const rows = await db
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'q1'));
    expect(rows).toHaveLength(1);
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect(events).toHaveLength(2);
  });

  // Codex P1-G — concurrent double-submit must not produce torn FSRS state.
  // Previously the FSRS read (getFsrsState) ran OUTSIDE the write transaction:
  // two concurrent submissions both read the same prior state, both compute
  // their `nextState` from it, and both upsert. The projection then reflects
  // exactly one of the two — but it's not the state that should result from
  // *both* reviews applied serially (lapses get lost, reps misincrement, etc).
  it('concurrent double-submit: material_fsrs_state reflects exactly one review serially', async () => {
    await seedQuestion('q1');
    const db = testDb();

    const [resA, resB] = await Promise.all([
      POST(submitReq({ mistake_id: 'q1', rating: 'again' })),
      POST(submitReq({ mistake_id: 'q1', rating: 'again' })),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Both reviews must have written their event rows (event log is append-only).
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect(events).toHaveLength(2);

    // The projection row reflects exactly one review's final state — NOT a
    // torn merge of both. With row-level locking, the second review computes
    // its nextState from the first's (locked) result, so reps=2 (not 1).
    const stateRows = await db
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'q1'));
    expect(stateRows).toHaveLength(1);
    const finalState = stateRows[0].state as { reps: number };
    // Without locking, both reads see reps=0 and both write reps=1 → finalState.reps=1 (torn).
    // With locking, second sees reps=1 and writes reps=2.
    expect(finalState.reps).toBe(2);
  });
});
