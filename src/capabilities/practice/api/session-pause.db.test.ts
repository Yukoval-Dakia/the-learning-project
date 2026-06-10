// YUK-57 — POST /api/review/sessions/[id]/pause coverage.

import { learning_session } from '@/db/schema';
import { Review } from '@/server/session';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './session-pause';

function jsonReq(id: string) {
  return new Request(`http://localhost/api/review/sessions/${id}/pause`, {
    method: 'POST',
  });
}

function paramsFor(id: string): Record<string, string> {
  return { id };
}

describe('POST /api/review/sessions/[id]/pause', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('moves started → paused', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    const res = await POST(jsonReq(sessionId), paramsFor(sessionId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: 'paused' });

    const db = testDb();
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('paused');
    expect(rows[0].ended_at).toBeNull();
  });

  it('returns 404 for nonexistent session id', async () => {
    const res = await POST(jsonReq('no_such_session'), paramsFor('no_such_session'));
    expect(res.status).toBe(404);
  });

  it('returns 409 when already paused', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    await Review.pauseReviewSession(testDb(), sessionId);
    const res = await POST(jsonReq(sessionId), paramsFor(sessionId));
    expect(res.status).toBe(409);
  });
});
