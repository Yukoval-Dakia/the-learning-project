import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, job_events, learning_session } from '@/db/schema';

import { assertActive, endConversation, startConversation } from './conversation';

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
