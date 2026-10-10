import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { artifact, learning_session } from '@/db/schema';
import { Review } from '@/server/session';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './review-sessions';

function createRequest(body?: unknown): Request {
  return new Request('http://localhost/api/review-sessions', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  });
}

async function seedPaper(id: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'tool_quiz',
      title: `卷 ${id}`,
      knowledge_ids: [],
      intent_source: 'quiz_gen',
      source: 'ai_generated',
      tool_kind: 'quiz_gen',
      tool_state: { question_ids: [], sections: [] },
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
}

describe('canonical review-session resources', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('serializes concurrent creates for the same paper', async () => {
    await seedPaper('paper_concurrent');

    const responses = await Promise.all([
      POST(createRequest({ paper_id: 'paper_concurrent' })),
      POST(createRequest({ paper_id: 'paper_concurrent' })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);

    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<{ session_id: string }>),
    );
    expect(bodies[1]?.session_id).toBe(bodies[0]?.session_id);

    const rows = await testDb().execute<{ id: string }>(sql`
      SELECT id
      FROM learning_session
      WHERE artifact_id = 'paper_concurrent'
        AND type = 'review'
        AND status IN ('started', 'paused')
    `);
    expect(rows as unknown as Array<{ id: string }>).toHaveLength(1);
  });

  it('reuses the newest active session when legacy duplicates already exist', async () => {
    await seedPaper('paper_duplicate');
    const db = testDb();
    const older = await Review.startReviewSession(db, { artifactId: 'paper_duplicate' });
    const newer = await Review.startReviewSession(db, { artifactId: 'paper_duplicate' });
    await db
      .update(learning_session)
      .set({ created_at: new Date('2026-07-13T00:00:00Z') })
      .where(eq(learning_session.id, older.sessionId));
    await db
      .update(learning_session)
      .set({ created_at: new Date('2026-07-14T00:00:00Z') })
      .where(eq(learning_session.id, newer.sessionId));

    const response = await POST(createRequest({ paper_id: 'paper_duplicate' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ session_id: newer.sessionId });
  });
});
