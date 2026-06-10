// ADR-0013 — POST /api/review/sessions/[id]/end closes the session.

import { learning_session } from '@/db/schema';
import { Review } from '@/server/session';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './session-end';

function jsonReq(id: string, body: unknown) {
  return new Request(`http://localhost/api/review/sessions/${id}/end`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function beaconReq(id: string, body: string) {
  return new Request(`http://localhost/api/review/sessions/${id}/end`, {
    method: 'POST',
    body,
    // sendBeacon default Content-Type — Blob with type='text/plain' OR no header
    headers: { 'content-type': 'text/plain' },
  });
}

function paramsFor(id: string): Record<string, string> {
  return { id };
}

describe('POST /api/review/sessions/[id]/end', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('completes a started session by default', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    const res = await POST(jsonReq(sessionId, {}), paramsFor(sessionId));
    expect(res.status).toBe(200);

    const db = testDb();
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('completed');
    expect(rows[0].ended_at).toBeTruthy();
  });

  it('abandons when status=abandoned', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    const res = await POST(jsonReq(sessionId, { status: 'abandoned' }), paramsFor(sessionId));
    expect(res.status).toBe(200);

    const db = testDb();
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('abandoned');
  });

  it('treats sendBeacon (text/plain) without parseable body as completed', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    const res = await POST(beaconReq(sessionId, ''), paramsFor(sessionId));
    expect(res.status).toBe(200);

    const db = testDb();
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('completed');
  });

  it('treats sendBeacon text/plain with JSON body as parsed', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    const res = await POST(
      beaconReq(sessionId, JSON.stringify({ status: 'abandoned' })),
      paramsFor(sessionId),
    );
    expect(res.status).toBe(200);
    const db = testDb();
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('abandoned');
  });

  it('returns 404 for nonexistent session id', async () => {
    const res = await POST(jsonReq('no_such_session', {}), paramsFor('no_such_session'));
    expect(res.status).toBe(404);
  });

  it('rejects invalid status enum', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    const res = await POST(jsonReq(sessionId, { status: 'mystery' }), paramsFor(sessionId));
    expect(res.status).toBe(400);
  });
});
