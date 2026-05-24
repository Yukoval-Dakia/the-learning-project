// YUK-14 — POST /api/teaching-sessions/[id]/end body parsing + dispatch.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { job_events, learning_session } from '@/db/schema';
import { Conversation } from '@/server/session';

import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { POST } from './route';

function jsonReq(id: string, body: unknown) {
  return new Request(`http://localhost/api/teaching-sessions/${id}/end`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function beaconReq(id: string, body: string) {
  return new Request(`http://localhost/api/teaching-sessions/${id}/end`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'text/plain' },
  });
}

async function paramsFor(id: string) {
  return Promise.resolve({ id });
}

describe('POST /api/teaching-sessions/[id]/end', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('ends an active session by default (empty JSON body)', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_e1' });
    const res = await POST(jsonReq(sessionId, {}), { params: paramsFor(sessionId) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; status: string };
    expect(json.status).toBe('ended');

    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('ended');
    expect(rows[0].ended_at).toBeTruthy();
  });

  it('ends an idle session (idle → ended)', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_e2' });
    await Conversation.idleConversation(db, sessionId);
    const res = await POST(jsonReq(sessionId, { status: 'ended' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('ended');
  });

  it('abandons when status=abandoned + records reason=pagehide_idle', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_e3' });
    const res = await POST(jsonReq(sessionId, { status: 'abandoned' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('abandoned');

    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    const abEvent = jevents.find((e) => e.event_type === 'conversation.abandoned');
    expect((abEvent?.payload as { reason?: string })?.reason).toBe('pagehide_idle');
  });

  it('treats sendBeacon text/plain empty body as ended', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_e4' });
    const res = await POST(beaconReq(sessionId, ''), { params: paramsFor(sessionId) });
    expect(res.status).toBe(200);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('ended');
  });

  it('treats sendBeacon text/plain with JSON body as parsed (abandoned)', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_e5' });
    const res = await POST(beaconReq(sessionId, JSON.stringify({ status: 'abandoned' })), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('abandoned');
  });

  it('returns 404 for nonexistent session id', async () => {
    const res = await POST(jsonReq('no_such_session', {}), {
      params: paramsFor('no_such_session'),
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 when session already ended', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_e7' });
    await Conversation.endConversation(db, sessionId);
    const res = await POST(jsonReq(sessionId, { status: 'ended' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(409);
  });

  it('returns 400 for invalid status enum value', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_e8' });
    const res = await POST(jsonReq(sessionId, { status: 'mystery' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(400);
  });
});
