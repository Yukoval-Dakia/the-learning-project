import { event, learning_session, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { Review } from '@/server/session';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

function req(id: string) {
  return new Request(`http://localhost/api/learning-sessions/${id}`, { method: 'GET' });
}

function paramsFor(id: string) {
  return Promise.resolve({ id });
}

describe('GET /api/learning-sessions/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('404 when session does not exist', async () => {
    const res = await GET(req('no_such'), { params: paramsFor('no_such') });
    expect(res.status).toBe(404);
  });

  it('returns session row with zero events when none chained', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    const res = await GET(req(sessionId), { params: paramsFor(sessionId) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      type: string;
      status: string;
      events: unknown[];
      duration_ms: number | null;
    };
    expect(body.id).toBe(sessionId);
    expect(body.type).toBe('review');
    expect(body.status).toBe('started');
    expect(body.events).toHaveLength(0);
    expect(body.duration_ms).toBeNull();
  });

  it('returns events chained via session_id with question prompts joined', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);

    const qId = createId();
    const now = new Date();
    await db.insert(question).values({
      id: qId,
      kind: 'short_answer',
      prompt_md: 'q · 之的用法？',
      reference_md: 'ref',
      source: 'manual',
      created_at: now,
      updated_at: now,
    });

    await writeEvent(db, {
      id: createId(),
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: qId,
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        fsrs_state_after: {
          due: now,
          stability: 1,
          difficulty: 5,
          scheduled_days: 1,
          learning_steps: 0,
          reps: 1,
          lapses: 0,
          state: 'review',
          last_review: now,
        },
        user_response_md: '我的答',
        referenced_knowledge_ids: [],
      },
      created_at: now,
    });

    const res = await GET(req(sessionId), { params: paramsFor(sessionId) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{
        action: string;
        subject_kind: string;
        payload: { fsrs_rating?: string };
        question: { prompt_md: string } | null;
      }>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0].action).toBe('review');
    expect(body.events[0].payload.fsrs_rating).toBe('good');
    expect(body.events[0].question?.prompt_md).toBe('q · 之的用法？');
  });

  it('computes duration_ms when session is completed', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);
    // Back-date started_at so completion produces non-zero duration
    const startedAgo = new Date(Date.now() - 90_000);
    await testDb()
      .update(learning_session)
      .set({ started_at: startedAgo })
      .where(eq(learning_session.id, sessionId));
    await Review.completeReviewSession(db, sessionId);

    const res = await GET(req(sessionId), { params: paramsFor(sessionId) });
    const body = (await res.json()) as { duration_ms: number; status: string };
    expect(body.status).toBe('completed');
    expect(body.duration_ms).toBeGreaterThan(0);
    // suppress unused import lint
    void event;
  });
});
