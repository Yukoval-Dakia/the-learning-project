import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { job_events, learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { writeJobEvent } from '@/server/events/writer';

import { assertFromState } from './guards';

// LearningSession.Tutor.* — YUK-193 solve-tutor session (spec §3.1).
//
// State machine: active → submitted → judged → ended, plus abandoned from any
// non-terminal state.
//
// Only this module writes learning_session(type='tutor') (ADR-0005, mirroring
// conversation.ts). The linked question id lives in the `goal_id` slot, as
// conversation keeps its learning item there.

const SESSION_TABLE = 'learning_session' as const;

async function loadTutorSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{ status: string; goal_id: string | null } | null> {
  const rows = await tx.execute<{ status: string; goal_id: string | null }>(
    sql`SELECT status, goal_id FROM learning_session WHERE id = ${sessionId} AND type = 'tutor' FOR UPDATE`,
  );
  const row = rows[0];
  if (!row) return null;
  return { status: row.status, goal_id: row.goal_id };
}

function notFound(sessionId: string): ApiError {
  return new ApiError('not_found', `learning_session ${sessionId} (type=tutor) not found`, 404);
}

export type StartTutorSessionParams = {
  /** The question this solve session is about (kept in the goal_id slot). */
  questionId: string;
  issuanceId?: string;
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
      payload: {
        question_id: params.questionId,
        ...(params.issuanceId ? { issuance_id: params.issuanceId } : {}),
      },
    });
    return { sessionId };
  });
}

// Runs inside a caller-supplied tx so the status change is atomic with sibling
// writes (attempt event + mistake in submitSolveAttempt). FOR UPDATE serialises
// concurrent transitions.
async function applyTransition(
  tx: Tx,
  sessionId: string,
  from: readonly string[],
  to: 'submitted' | 'judged' | 'ended' | 'abandoned',
  eventType: string,
  setEndedAt: boolean,
): Promise<void> {
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
    await applyTransition(tx, sessionId, from, to, eventType, setEndedAt);
  });
}

export async function markSubmitted(db: Db, sessionId: string): Promise<void> {
  await transition(db, sessionId, ['active'] as const, 'submitted', 'tutor.submitted', false);
}

export async function markJudged(db: Db, sessionId: string): Promise<void> {
  await transition(db, sessionId, ['submitted'] as const, 'judged', 'tutor.judged', false);
}

/** active → submitted inside a caller's tx (atomic with the attempt write). */
export async function markSubmittedTx(tx: Tx, sessionId: string): Promise<void> {
  await applyTransition(tx, sessionId, ['active'] as const, 'submitted', 'tutor.submitted', false);
}

/** submitted → judged inside a caller's tx (atomic with the attempt write). */
export async function markJudgedTx(tx: Tx, sessionId: string): Promise<void> {
  await applyTransition(tx, sessionId, ['submitted'] as const, 'judged', 'tutor.judged', false);
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

/** Read the linked question id, status, and issuance id. */
export async function getTutorQuestionId(
  db: Db,
  sessionId: string,
): Promise<{ questionId: string | null; status: string; issuanceId?: string }> {
  const rows = await db
    .select({ status: learning_session.status, goal_id: learning_session.goal_id })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'tutor')))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(sessionId);
  const [started] = await db
    .select({ payload: job_events.payload })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, SESSION_TABLE),
        eq(job_events.business_id, sessionId),
        eq(job_events.event_type, 'tutor.started'),
      ),
    )
    .limit(1);
  const issuanceId = started?.payload?.issuance_id;
  return {
    questionId: row.goal_id,
    status: row.status,
    ...(typeof issuanceId === 'string' ? { issuanceId } : {}),
  };
}
