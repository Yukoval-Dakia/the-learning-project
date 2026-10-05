import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, learning_record, learning_session } from '@/db/schema';
import { Tutor } from '@/server/session';
import { seedFrozenSolveQuestion } from '../../../../tests/fixtures/assessment-solve';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const db = testDb();

async function seedAndStart() {
  const frozen = await seedFrozenSolveQuestion(db);
  const { sessionId } = await Tutor.startTutorSession(db, {
    questionId: frozen.id,
    issuanceId: frozen.issuanceId,
  });
  const key = `solve_${sessionId}`;
  return {
    id: frozen.id,
    sessionId,
    assessment: {
      issuance_id: frozen.issuanceId,
      evaluation_group_id: key,
      idempotency_key: key,
      response_set: frozen.responseSet('wrong original answer'),
    },
  };
}

describe('POST /api/questions/[id]/solve/[sid]/submit', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('typed submit → judged, reveals solution, enrolls mistake on low score', async () => {
    const { POST } = await import('./solve-submit');
    const { id, sessionId, assessment } = await seedAndStart();

    const res = await POST(
      new Request('http://t/x', {
        method: 'POST',
        body: JSON.stringify({ assessment, student_final_answer_text: 'wrong' }),
      }),
      { id, sid: sessionId },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attempt_event_id: string;
      judge: { coarse_outcome: string };
      revealed_solution_md: string;
      mistake_id?: string;
    };
    expect(body.judge.coarse_outcome).toBe('incorrect');
    expect(body.revealed_solution_md).toContain('a+b');
    const mistakeId = body.mistake_id;
    expect(mistakeId).toBeDefined();
    if (!mistakeId) throw new Error('expected a failure attempt id');

    const [attempt] = await db.select().from(event).where(eq(event.id, body.attempt_event_id));
    expect(attempt.action).toBe('experimental:assessment_attempt');
    expect(attempt.outcome).toBeNull(); // effective evaluation, not capture, owns the verdict
    expect(attempt.subject_id).toBe(id);

    const [s] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(s.status).toBe('judged');
    const records = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.question_id, id));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: mistakeId,
      attempt_event_id: body.attempt_event_id,
    });
  });

  it('YUK-562: writes reasoning_trace (steps only) separately while response_md keeps the full join', async () => {
    const { POST } = await import('./solve-submit');
    const { id, sessionId, assessment } = await seedAndStart();

    const res = await POST(
      new Request('http://t/x', {
        method: 'POST',
        body: JSON.stringify({
          assessment,
          student_text_steps: ['因式分解 (a-b)(a+b)', '约去 (a-b)'],
          student_final_answer_text: 'a + b',
        }),
      }),
      { id, sid: sessionId },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt_event_id: string };

    const [attempt] = await db.select().from(event).where(eq(event.id, body.attempt_event_id));
    const payload = attempt.payload as { response_md: string | null; reasoning_trace?: string };
    // response_md keeps the existing join (steps + final answer) — backward compatible.
    expect(payload.response_md).toBe('因式分解 (a-b)(a+b)\n约去 (a-b)\na + b');
    // reasoning_trace captures ONLY the process steps, separate from the final answer.
    expect(payload.reasoning_trace).toBe('因式分解 (a-b)(a+b)\n约去 (a-b)');
  });

  it('YUK-562: omits reasoning_trace when only a final answer (no steps) is submitted', async () => {
    const { POST } = await import('./solve-submit');
    const { id, sessionId, assessment } = await seedAndStart();

    const res = await POST(
      new Request('http://t/x', {
        method: 'POST',
        body: JSON.stringify({ assessment, student_final_answer_text: 'a + b' }),
      }),
      { id, sid: sessionId },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt_event_id: string };

    const [attempt] = await db.select().from(event).where(eq(event.id, body.attempt_event_id));
    const payload = attempt.payload as { response_md: string | null; reasoning_trace?: string };
    expect(payload.response_md).toBe('a + b');
    // No process steps → the field is ABSENT (byte-identical to the pre-YUK-562 payload).
    expect(payload.reasoning_trace).toBeUndefined();
  });

  it('rejects missing native input without inventing an incorrect verdict', async () => {
    const { POST } = await import('./solve-submit');
    const { id, sessionId } = await seedAndStart();
    const res = await POST(
      new Request('http://t/x', { method: 'POST', body: JSON.stringify({}) }),
      { id, sid: sessionId },
    );
    expect(res.status).toBe(409);
  });
});
