import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, job_events, learning_session } from '@/db/schema';

import {
  abandonConversation,
  assertAcceptingTurns,
  assertActive,
  endConversation,
  idleConversation,
  startConversation,
} from './conversation';

async function cleanup(sessionId: string): Promise<void> {
  await db.delete(event).where(eq(event.session_id, sessionId));
  await db.delete(learning_session).where(eq(learning_session.id, sessionId));
  await db.delete(job_events).where(eq(job_events.business_id, sessionId));
}

describe('Conversation.startConversation', () => {
  it('inserts learning_session(type=conversation, status=active) + goal_id=learningItemId', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_test' });
    expect(sessionId).toBeTruthy();
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('conversation');
    expect(rows[0].status).toBe('active');
    expect(rows[0].goal_id).toBe('li_test');
    expect(rows[0].started_at).toBeTruthy();
    expect(rows[0].ended_at).toBeNull();
    await cleanup(sessionId);
  });

  it('writes a job_events row but no domain event (messages come later)', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_test' });
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    expect(jevents.find((e) => e.event_type === 'conversation.started')).toBeTruthy();
    const events = await db.select().from(event).where(eq(event.session_id, sessionId));
    expect(events).toHaveLength(0);
    await cleanup(sessionId);
  });
});

describe('Conversation.endConversation', () => {
  it('active → ended + ended_at set + version bump', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_test' });
    await endConversation(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('ended');
    expect(rows[0].ended_at).toBeTruthy();
    expect(rows[0].version).toBe(1);
    await cleanup(sessionId);
  });

  it('404 when session missing', async () => {
    await expect(endConversation(db, 'never-existed')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('rejects double end (active → ended → ended)', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_test' });
    await endConversation(db, sessionId);
    await expect(endConversation(db, sessionId)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });
});

describe('Conversation.endConversation (YUK-14 idle→ended)', () => {
  it('idle → ended is allowed (T5 from idle)', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_test' });
    await idleConversation(db, sessionId);
    await endConversation(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('ended');
    expect(rows[0].ended_at).toBeTruthy();
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    const endedEvent = jevents.find((e) => e.event_type === 'conversation.ended');
    expect(endedEvent).toBeTruthy();
    expect((endedEvent?.payload as { from_status?: string })?.from_status).toBe('idle');
    await cleanup(sessionId);
  });
});

describe('Conversation.idleConversation', () => {
  it('active → idle + writes conversation.idle job_event', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_idle' });
    await idleConversation(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('idle');
    expect(rows[0].ended_at).toBeNull(); // idle is not terminal
    expect(rows[0].version).toBe(1);
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    expect(jevents.find((e) => e.event_type === 'conversation.idle')).toBeTruthy();
    await cleanup(sessionId);
  });

  it('rejects idle → idle (409)', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_idle2' });
    await idleConversation(db, sessionId);
    await expect(idleConversation(db, sessionId)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });

  it('rejects ended → idle (409)', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_idle3' });
    await endConversation(db, sessionId);
    await expect(idleConversation(db, sessionId)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });

  it('404 when session missing', async () => {
    await expect(idleConversation(db, 'never-existed')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});

describe('Conversation.abandonConversation', () => {
  it('active → abandoned (direct, e.g. pagehide_explicit)', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_ab1' });
    await abandonConversation(db, sessionId, 'pagehide_explicit');
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('abandoned');
    expect(rows[0].ended_at).toBeTruthy();
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    const abEvent = jevents.find((e) => e.event_type === 'conversation.abandoned');
    expect(abEvent).toBeTruthy();
    expect((abEvent?.payload as { reason?: string })?.reason).toBe('pagehide_explicit');
    await cleanup(sessionId);
  });

  it('idle → abandoned (orphan cron path)', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_ab2' });
    await idleConversation(db, sessionId);
    await abandonConversation(db, sessionId, 'orphan_cron');
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('abandoned');
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    const abEvent = jevents.find((e) => e.event_type === 'conversation.abandoned');
    expect((abEvent?.payload as { reason?: string; from_status?: string })?.reason).toBe(
      'orphan_cron',
    );
    expect((abEvent?.payload as { reason?: string; from_status?: string })?.from_status).toBe(
      'idle',
    );
    await cleanup(sessionId);
  });

  it('rejects ended → abandoned (409)', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_ab3' });
    await endConversation(db, sessionId);
    await expect(abandonConversation(db, sessionId, 'orphan_cron')).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });

  it('rejects abandoned → abandoned (409)', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_ab4' });
    await abandonConversation(db, sessionId, 'orphan_cron');
    await expect(abandonConversation(db, sessionId, 'orphan_cron')).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });
});

describe('Conversation.assertAcceptingTurns', () => {
  it('active session: returns wasIdle=false + goalId, no state change', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_at1' });
    const r = await assertAcceptingTurns(db, sessionId);
    expect(r.goalId).toBe('li_at1');
    expect(r.wasIdle).toBe(false);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('active');
    expect(rows[0].version).toBe(0); // no transition write
    await cleanup(sessionId);
  });

  it('idle session: auto-resumes (idle→active) + wasIdle=true + writes conversation.resumed', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_at2' });
    await idleConversation(db, sessionId);
    const r = await assertAcceptingTurns(db, sessionId);
    expect(r.wasIdle).toBe(true);
    expect(r.goalId).toBe('li_at2');
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('active');
    expect(rows[0].version).toBe(2); // idle bump + resume bump
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    expect(jevents.find((e) => e.event_type === 'conversation.resumed')).toBeTruthy();
    await cleanup(sessionId);
  });

  it('ended session: 409', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_at3' });
    await endConversation(db, sessionId);
    await expect(assertAcceptingTurns(db, sessionId)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });

  it('abandoned session: 409', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_at4' });
    await abandonConversation(db, sessionId, 'orphan_cron');
    await expect(assertAcceptingTurns(db, sessionId)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });

  it('404 when missing', async () => {
    await expect(assertAcceptingTurns(db, 'never-existed')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});

describe('Conversation.assertActive', () => {
  it('passes for an active session and returns the goal_id', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_x' });
    const r = await assertActive(db, sessionId);
    expect(r.goalId).toBe('li_x');
    await cleanup(sessionId);
  });

  it('throws conflict 409 when session is ended', async () => {
    const { sessionId } = await startConversation(db, { learningItemId: 'li_x' });
    await endConversation(db, sessionId);
    await expect(assertActive(db, sessionId)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });

  it('throws not_found 404 when session does not exist', async () => {
    await expect(assertActive(db, 'never-existed')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});
