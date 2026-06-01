import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { learning_session } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import * as Tutor from './tutor';

const db = testDb();

describe('Tutor session module', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('startTutorSession creates a tutor session in active linked to the question', async () => {
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: 'q1' });
    const [row] = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(row.type).toBe('tutor');
    expect(row.status).toBe('active');
    expect(row.goal_id).toBe('q1');
  });

  it('active → submitted → judged', async () => {
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: 'q1' });
    await Tutor.markSubmitted(db, sessionId);
    let [row] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(row.status).toBe('submitted');
    await Tutor.markJudged(db, sessionId);
    [row] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(row.status).toBe('judged');
  });

  it('judged → ended', async () => {
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: 'q1' });
    await Tutor.markSubmitted(db, sessionId);
    await Tutor.markJudged(db, sessionId);
    await Tutor.endTutor(db, sessionId);
    const [row] = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(row.status).toBe('ended');
    expect(row.ended_at).not.toBeNull();
  });

  it('rejects markJudged from active (bad transition)', async () => {
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: 'q1' });
    await expect(Tutor.markJudged(db, sessionId)).rejects.toThrow();
  });

  it('getTutorQuestionId returns the linked question for an accepting session', async () => {
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: 'q1' });
    const { questionId, status } = await Tutor.getTutorQuestionId(db, sessionId);
    expect(questionId).toBe('q1');
    expect(status).toBe('active');
  });

  it('throws 404 for an unknown session id', async () => {
    await expect(Tutor.markSubmitted(db, 'nope')).rejects.toThrow();
  });

  it('getTutorQuestionId ignores non-tutor sessions (type filter)', async () => {
    const now = new Date();
    await db.insert(learning_session).values({
      id: 'not_a_tutor',
      type: 'explore',
      status: 'placeholder',
      source_document_id: null,
      source_asset_ids: [],
      entrypoint: null,
      warnings: [],
      error_message: null,
      summary_md: null,
      goal_id: 'q9',
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await expect(Tutor.getTutorQuestionId(db, 'not_a_tutor')).rejects.toThrow();
  });
});
