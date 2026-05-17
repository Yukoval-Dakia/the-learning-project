import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError } from '@/server/http/errors';

import { assertFromState } from './guards';

// LearningSession.Conversation.* — Phase 2C Active Teaching Session.
//
// State machine (ADR-0008):
//   active → ended
//
// MVP 不实装 `idle`（spec 三态留作 Phase 3 idle-timeout 触发）。Conversation
// sessions 跟 Review sessions 一样是 state envelope —— message events 由 route
// 层用 writeEvent 直接写，session_id 链回这里。
//
// Single-owner invariant (ADR-0005)：本模块是 type='conversation' 的
// learning_session 唯一写路径；route / handler 不许直接 update。

const SESSION_TABLE = 'learning_session' as const;

async function loadConversationSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{ status: string; goal_id: string | null } | null> {
  const rows = await tx.execute(
    sql`SELECT status, goal_id FROM learning_session WHERE id = ${sessionId} AND type = 'conversation' FOR UPDATE`,
  );
  const arr = rows as unknown as Array<{ status: string; goal_id: string | null }>;
  const row = arr[0];
  if (!row) return null;
  return { status: row.status, goal_id: row.goal_id };
}

// ---------- startConversation ----------

export type StartConversationParams = {
  /** LearningItem this conversation is teaching about (kept in goal_id slot). */
  learningItemId: string;
};

export async function startConversation(
  db: Db,
  params: StartConversationParams,
): Promise<{ sessionId: string }> {
  return db.transaction(async (tx) => {
    const sessionId = createId();
    const now = new Date();
    await tx.insert(learning_session).values({
      id: sessionId,
      type: 'conversation',
      status: 'active',
      source_document_id: null,
      source_asset_ids: [],
      entrypoint: null,
      warnings: [],
      error_message: null,
      summary_md: null,
      goal_id: params.learningItemId,
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'conversation.started',
      payload: { learning_item_id: params.learningItemId },
    });

    return { sessionId };
  });
}

// ---------- endConversation ----------

export async function endConversation(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadConversationSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError(
        'not_found',
        `learning_session ${sessionId} (type=conversation) not found`,
        404,
      );
    }
    assertFromState(current.status, ['active'] as const, sessionId, 'Conversation.endConversation');

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'ended',
        ended_at: now,
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'conversation.ended',
      payload: {},
    });
  });
}

// ---------- assertActive ----------

/**
 * Throw `ApiError('conflict', ..., 409)` unless the conversation session is
 * status='active'. Used by /turn route to gate further messages.
 */
export async function assertActive(db: Db, sessionId: string): Promise<{ goalId: string | null }> {
  const rows = await db
    .select({ status: learning_session.status, goal_id: learning_session.goal_id })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new ApiError(
      'not_found',
      `learning_session ${sessionId} (type=conversation) not found`,
      404,
    );
  }
  if (row.status !== 'active') {
    throw new ApiError(
      'conflict',
      `learning_session ${sessionId} status=${row.status}, expected active`,
      409,
    );
  }
  return { goalId: row.goal_id };
}
