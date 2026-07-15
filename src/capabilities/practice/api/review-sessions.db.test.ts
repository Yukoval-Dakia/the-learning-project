import { artifact, learning_session } from '@/db/schema';
import { Review } from '@/server/session';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { ReviewSessionCreatedSchema } from './contracts';
import { GET as legacyPracticeGet, POST as legacyPracticePost } from './legacy-practice';
import { POST as legacyReviewSessionPost } from './legacy-review-sessions';
import { PaperListResponseSchema } from './paper-contracts';
import { GET } from './review-session-detail';
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

  it('creates an unbound review session with 201 and a resolvable Location', async () => {
    const created = await POST(createRequest());
    expect(created.status).toBe(201);
    const body = ReviewSessionCreatedSchema.parse(await created.json());
    expect(created.headers.get('location')).toBe(`/api/review-sessions/${body.session_id}`);

    const detail = await GET(
      new Request(`http://localhost/api/review-sessions/${body.session_id}`),
      { id: body.session_id },
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      id: body.session_id,
      type: 'review',
      status: 'started',
      paper_id: null,
    });
  });

  it('returns 201 for a new paper session and 200 when the active session is reused', async () => {
    await seedPaper('paper_1');

    const first = await POST(createRequest({ paper_id: 'paper_1' }));
    expect(first.status).toBe(201);
    const firstBody = ReviewSessionCreatedSchema.parse(await first.json());
    expect(first.headers.get('location')).toBe(`/api/review-sessions/${firstBody.session_id}`);

    const second = await POST(createRequest({ paper_id: 'paper_1' }));
    expect(second.status).toBe(200);
    const secondBody = ReviewSessionCreatedSchema.parse(await second.json());
    expect(secondBody.session_id).toBe(firstBody.session_id);
    expect(second.headers.get('location')).toBe(first.headers.get('location'));
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

  it('rejects unknown request fields instead of silently accepting a legacy body', async () => {
    const response = await POST(createRequest({ artifact_id: 'paper_1' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'validation_error',
      message: expect.stringContaining('artifact_id'),
    });
  });

  it('rejects malformed JSON instead of treating it as an empty create request', async () => {
    const response = await POST(
      new Request('http://localhost/api/review-sessions', {
        method: 'POST',
        body: '{',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown review session', async () => {
    const response = await GET(new Request('http://localhost/api/review-sessions/missing'), {
      id: 'missing',
    });
    expect(response.status).toBe(404);
  });

  it('keeps legacy collection routes working while advertising their successors', async () => {
    const papers = await legacyPracticeGet(new Request('http://localhost/api/practice'));
    expect(papers.status).toBe(200);
    expect(papers.headers.get('deprecation')).toBe('@1783987200');
    expect(papers.headers.get('link')).toBe('</api/papers>; rel="successor-version"');
    expect(PaperListResponseSchema.parse(await papers.json())).toMatchObject({
      data: [],
      papers: [],
      page: { limit: 50, next_cursor: null },
    });

    const session = await legacyReviewSessionPost(
      new Request('http://localhost/api/review/sessions', { method: 'POST' }),
    );
    expect(session.status).toBe(200);
    expect(session.headers.get('deprecation')).toBe('@1783987200');
    expect(session.headers.get('link')).toBe('</api/review-sessions>; rel="successor-version"');
    const sessionBody = ReviewSessionCreatedSchema.parse(await session.json());
    expect(session.headers.get('location')).toBe(`/api/review-sessions/${sessionBody.session_id}`);
  });

  it('forwards the legacy review-session request body to the canonical handler', async () => {
    await seedPaper('paper_legacy');

    const session = await legacyReviewSessionPost(createRequest({ paper_id: 'paper_legacy' }));
    expect(session.status).toBe(200);
    const body = ReviewSessionCreatedSchema.parse(await session.json());

    const detail = await GET(
      new Request(`http://localhost/api/review-sessions/${body.session_id}`),
      { id: body.session_id },
    );
    await expect(detail.json()).resolves.toMatchObject({
      id: body.session_id,
      paper_id: 'paper_legacy',
    });
  });

  it('keeps legacy paper-session creation on artifact_id while advertising review sessions', async () => {
    await seedPaper('paper_practice_legacy');

    const response = await legacyPracticePost(
      new Request('http://localhost/api/practice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifact_id: 'paper_practice_legacy' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('deprecation')).toBe('@1783987200');
    expect(response.headers.get('link')).toBe('</api/review-sessions>; rel="successor-version"');
    const body = ReviewSessionCreatedSchema.parse(await response.json());
    const rows = await testDb()
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, body.session_id));
    expect(rows[0]?.artifact_id).toBe('paper_practice_legacy');
  });
});
