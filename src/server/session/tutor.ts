import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError } from '@/server/http/errors';

import { assertFromState } from './guards';

// LearningSession.Tutor.* — YUK-193 solve-tutor session (spec §3.1).
//
// State machine (docs/superpowers/specs/2026-06-01-solve-tutor-design.md §3.1):
//   active → submitted → judged → ended   (+ abandoned terminal)
//
// This module is the ONLY allowed writer of learning_session(type='tutor')
// (ADR-0005 single-owner invariant, mirrors conversation.ts). Routes / handlers
// MUST NOT update learning_session for type='tutor' directly. The linked
// question_id lives in the `goal_id` slot (same convention conversation.ts uses
// for learning_item_id).

const SESSION_TABLE = 'learning_session' as const;

async function loadTutorSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{ status: string; goal_id: string | null } | null> {
  const rows = await tx.execute(
    sql`SELECT status, goal_id FROM learning_session WHERE id = ${sessionId} AND type = 'tutor' FOR UPDATE`,
  );
  const arr = rows as unknown as Array<{ status: string; goal_id: string | null }>;
  const row = arr[0];
  if (!row) return null;
  return { status: row.status, goal_id: row.goal_id };
}

function notFound(sessionId: string): ApiError {
  return new ApiError('not_found', `learning_session ${sessionId} (type=tutor) not found`, 404);
}

export type StartTutorSessionParams = {
  /** The question this solve session is about (kept in the goal_id slot). */
  questionId: string;
};

export async function startTutorSession(
  db: Db,
  params: StartTutorSessionParams,
): Promise<{ sessionId: string }> {
  return db.transaction(async (tx) => {
    const sessionId = createId();
    const now = new Date();
    await tx.insert(learning_session).values({
      id: sessionId,
      type: 'tutor',
      status: 'active',
      source_document_id: null,
      source_asset_ids: [],
      entrypoint: null,
      warnings: [],
      error_message: null,
      summary_md: null,
      goal_id: params.questionId,
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'tutor.started',
      payload: { question_id: params.questionId },
    });
    return { sessionId };
  });
}

async function transition(
  db: Db,
  sessionId: string,
  from: readonly string[],
  to: 'submitted' | 'judged' | 'ended' | 'abandoned',
  eventType: string,
  setEndedAt: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadTutorSessionForUpdate(tx, sessionId);
    if (!current) throw notFound(sessionId);
    assertFromState(current.status, from, sessionId, `Tutor.${to}`);
    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: to,
        ...(setEndedAt ? { ended_at: now } : {}),
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: eventType,
      payload: { from_status: current.status },
    });
  });
}

export async function markSubmitted(db: Db, sessionId: string): Promise<void> {
  await transition(db, sessionId, ['active'] as const, 'submitted', 'tutor.submitted', false);
}

export async function markJudged(db: Db, sessionId: string): Promise<void> {
  await transition(db, sessionId, ['submitted'] as const, 'judged', 'tutor.judged', false);
}

export async function endTutor(db: Db, sessionId: string): Promise<void> {
  await transition(db, sessionId, ['active', 'judged'] as const, 'ended', 'tutor.ended', true);
}

export async function abandonTutor(db: Db, sessionId: string): Promise<void> {
  await transition(
    db,
    sessionId,
    ['active', 'submitted', 'judged'] as const,
    'abandoned',
    'tutor.abandoned',
    true,
  );
}

/** Read the linked question id + status for an accepting (active) session. */
export async function getTutorQuestionId(
  db: Db,
  sessionId: string,
): Promise<{ questionId: string | null; status: string }> {
  const rows = await db
    .select({ status: learning_session.status, goal_id: learning_session.goal_id })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(sessionId);
  return { questionId: row.goal_id, status: row.status };
}
