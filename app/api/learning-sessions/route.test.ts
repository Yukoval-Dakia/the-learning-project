import { question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { Review } from '@/server/session';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { GET } from './route';

function req(path = 'http://localhost/api/learning-sessions') {
  return new Request(path, { method: 'GET' });
}

describe('GET /api/learning-sessions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('lists recent review sessions with review counts and touched knowledge', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);
    const qId = createId();
    const now = new Date();
    await db.insert(question).values({
      id: qId,
      kind: 'short_answer',
      prompt_md: 'q',
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
        user_response_md: null,
        referenced_knowledge_ids: ['k1'],
      },
      created_at: now,
    });

    const res = await GET(req('http://localhost/api/learning-sessions?type=review&limit=5'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        id: string;
        type: string;
        reviewed_count: number;
        rating_counts: { good: number };
        knowledge_touched: string[];
      }>;
    };

    expect(body.rows[0].id).toBe(sessionId);
    expect(body.rows[0].type).toBe('review');
    expect(body.rows[0].reviewed_count).toBe(1);
    expect(body.rows[0].rating_counts.good).toBe(1);
    expect(body.rows[0].knowledge_touched).toEqual(['k1']);
  });
});
