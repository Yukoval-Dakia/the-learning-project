import { artifact } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET as legacyPracticeGet } from './legacy-practice';
import { POST as legacyReviewSessionPost } from './legacy-review-sessions';
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
    const body = (await created.json()) as { session_id: string };
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
    const firstBody = (await first.json()) as { session_id: string };
    expect(first.headers.get('location')).toBe(`/api/review-sessions/${firstBody.session_id}`);

    const second = await POST(createRequest({ paper_id: 'paper_1' }));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { session_id: string };
    expect(secondBody.session_id).toBe(firstBody.session_id);
    expect(second.headers.get('location')).toBe(first.headers.get('location'));
  });

  it('rejects unknown request fields instead of silently accepting a legacy body', async () => {
    const response = await POST(createRequest({ artifact_id: 'paper_1' }));
    expect(response.status).toBe(400);
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
    const papers = await legacyPracticeGet();
    expect(papers.status).toBe(200);
    expect(papers.headers.get('deprecation')).toBe('@1783987200');
    expect(papers.headers.get('link')).toBe('</api/papers>; rel="successor-version"');
    await expect(papers.json()).resolves.toEqual({ papers: [] });

    const session = await legacyReviewSessionPost();
    expect(session.status).toBe(200);
    expect(session.headers.get('deprecation')).toBe('@1783987200');
    expect(session.headers.get('link')).toBe('</api/review-sessions>; rel="successor-version"');
    await expect(session.json()).resolves.toMatchObject({ session_id: expect.any(String) });
  });
});
