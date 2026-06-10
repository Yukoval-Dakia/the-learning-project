import { learning_session } from '@/db/schema';
import { Review } from '@/server/session';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './session-reopen';

function req(id: string) {
  return new Request(`http://localhost/api/review/sessions/${id}/reopen`, { method: 'POST' });
}

function paramsFor(id: string): Record<string, string> {
  return { id };
}

describe('POST /api/review/sessions/[id]/reopen', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('moves abandoned → started', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    await Review.abandonReviewSession(testDb(), sessionId);
    const res = await POST(req(sessionId), paramsFor(sessionId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: 'started' });

    const rows = await testDb()
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('started');
    expect(rows[0].ended_at).toBeNull();
  });

  it('404s for a missing session', async () => {
    const res = await POST(req('no_such'), paramsFor('no_such'));
    expect(res.status).toBe(404);
  });

  it('409s for a non-abandoned session', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    const res = await POST(req(sessionId), paramsFor(sessionId));
    expect(res.status).toBe(409);
  });
});
