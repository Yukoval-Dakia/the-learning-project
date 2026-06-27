import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, job_events, learning_session } from '@/db/schema';
import { ApiError } from '@/server/http/errors';

import {
  abandonPlacementSession,
  completePlacementSession,
  loadPlacementSessionForUpdate,
  startPlacementSession,
} from './placement';

async function cleanup(sessionId: string): Promise<void> {
  await db.delete(event).where(eq(event.session_id, sessionId));
  await db.delete(learning_session).where(eq(learning_session.id, sessionId));
  await db.delete(job_events).where(eq(job_events.business_id, sessionId));
}

describe('Placement.startPlacementSession', () => {
  it('inserts learning_session(type=placement, status=started) and returns sessionId', async () => {
    const { sessionId } = await startPlacementSession(db);
    expect(sessionId).toBeTruthy();
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('placement');
    expect(rows[0].status).toBe('started');
    expect(rows[0].started_at).toBeTruthy();
    expect(rows[0].ended_at).toBeNull();
    await cleanup(sessionId);
  });

  it('optionally stores goal_id (the probe scope)', async () => {
    const { sessionId } = await startPlacementSession(db, { goalId: 'g_probe' });
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].goal_id).toBe('g_probe');
    await cleanup(sessionId);
  });

  it('persists scope_knowledge_ids server-side (YUK-470) when knowledgeIds is supplied', async () => {
    const { sessionId } = await startPlacementSession(db, { knowledgeIds: ['kc1', 'kc2'] });
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].scope_knowledge_ids).toEqual(['kc1', 'kc2']);
    await cleanup(sessionId);
  });

  it('leaves scope_knowledge_ids null when knowledgeIds is omitted (back-compat)', async () => {
    const { sessionId } = await startPlacementSession(db);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].scope_knowledge_ids).toBeNull();
    await cleanup(sessionId);
  });

  it('persists the onboarding self-report (YUK-480 leanings + pace) when supplied', async () => {
    const { sessionId } = await startPlacementSession(db, {
      knowledgeIds: ['kc1'],
      leanings: ['math', 'physics'],
      pace: 'light',
    });
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].placement_leanings).toEqual(['math', 'physics']);
    expect(rows[0].placement_pace).toBe('light');
    await cleanup(sessionId);
  });

  it('normalizes empty leanings to null + leaves self-report null when omitted (back-compat)', async () => {
    const omitted = await startPlacementSession(db);
    const r1 = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, omitted.sessionId));
    expect(r1[0].placement_leanings).toBeNull();
    expect(r1[0].placement_pace).toBeNull();
    await cleanup(omitted.sessionId);

    // empty leanings array → null (no preference), pace explicitly null stays null.
    const empty = await startPlacementSession(db, { leanings: [], pace: null });
    const r2 = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, empty.sessionId));
    expect(r2[0].placement_leanings).toBeNull();
    expect(r2[0].placement_pace).toBeNull();
    await cleanup(empty.sessionId);
  });

  it('writes a job_events placement.started row but NO domain event', async () => {
    const { sessionId } = await startPlacementSession(db);
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    expect(jevents.find((e) => e.event_type === 'placement.started')).toBeTruthy();
    const events = await db.select().from(event).where(eq(event.session_id, sessionId));
    expect(events).toHaveLength(0);
    await cleanup(sessionId);
  });
});

describe('Placement.loadPlacementSessionForUpdate (YUK-470 row lock + server-side scope)', () => {
  it('returns status + persisted scope_knowledge_ids + self-report under FOR UPDATE', async () => {
    const { sessionId } = await startPlacementSession(db, {
      knowledgeIds: ['kc1', 'kc2'],
      leanings: ['math'],
      pace: 'dense',
    });
    const locked = await db.transaction((tx) => loadPlacementSessionForUpdate(tx, sessionId));
    expect(locked).toEqual({
      status: 'started',
      scopeKnowledgeIds: ['kc1', 'kc2'],
      leanings: ['math'],
      pace: 'dense',
    });
    await cleanup(sessionId);
  });

  it('returns null scope + null self-report when none was persisted', async () => {
    const { sessionId } = await startPlacementSession(db);
    const locked = await db.transaction((tx) => loadPlacementSessionForUpdate(tx, sessionId));
    expect(locked).toEqual({
      status: 'started',
      scopeKnowledgeIds: null,
      leanings: null,
      pace: null,
    });
    await cleanup(sessionId);
  });

  it('returns null for a missing / non-placement session', async () => {
    const missing = await db.transaction((tx) => loadPlacementSessionForUpdate(tx, 'never'));
    expect(missing).toBeNull();
  });
});

describe('Placement.completePlacementSession', () => {
  it('started → completed + ended_at set + version bump + placement.completed event', async () => {
    const { sessionId } = await startPlacementSession(db);
    await completePlacementSession(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('completed');
    expect(rows[0].ended_at).toBeTruthy();
    expect(rows[0].version).toBe(1);
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    expect(jevents.find((e) => e.event_type === 'placement.completed')).toBeTruthy();
    await cleanup(sessionId);
  });

  it('404 when session missing', async () => {
    await expect(completePlacementSession(db, 'never-existed')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('refuses to complete a non-placement (type filter)', async () => {
    const id = 'review_for_placement_filter_test';
    const now = new Date();
    await db.insert(learning_session).values({
      id,
      type: 'review',
      status: 'started',
      source_document_id: null,
      source_asset_ids: [],
      entrypoint: null,
      warnings: [],
      error_message: null,
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await expect(completePlacementSession(db, id)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await db.delete(learning_session).where(eq(learning_session.id, id));
  });

  it('rejects re-complete (status=completed → 409)', async () => {
    const { sessionId } = await startPlacementSession(db);
    await completePlacementSession(db, sessionId);
    await expect(completePlacementSession(db, sessionId)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });
});

describe('Placement.abandonPlacementSession', () => {
  it('started → abandoned + ended_at + version bump + placement.abandoned event', async () => {
    const { sessionId } = await startPlacementSession(db);
    await abandonPlacementSession(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('abandoned');
    expect(rows[0].ended_at).toBeTruthy();
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    expect(jevents.find((e) => e.event_type === 'placement.abandoned')).toBeTruthy();
    await cleanup(sessionId);
  });

  it('rejects abandon-after-complete (status=completed → 409)', async () => {
    const { sessionId } = await startPlacementSession(db);
    await completePlacementSession(db, sessionId);
    await expect(abandonPlacementSession(db, sessionId)).rejects.toBeInstanceOf(ApiError);
    await cleanup(sessionId);
  });

  it('writes no domain event', async () => {
    const { sessionId } = await startPlacementSession(db);
    await abandonPlacementSession(db, sessionId);
    const events = await db.select().from(event).where(eq(event.session_id, sessionId));
    expect(events).toHaveLength(0);
    await cleanup(sessionId);
  });
});
