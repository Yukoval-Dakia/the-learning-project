import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError } from '@/server/http/errors';

import { assertFromState } from './guards';

// LearningSession.Conversation.* — Phase 2C Active Teaching Session.
//
// State machine (ADR-0008 + YUK-14
// docs/design/2026-05-24-teaching-idle-state-machine.md):
//
//                +----------+
//                |  active  |◀───────────┐ (T2b: user msg in /turn)
//                +----+-----+            │
//             T4 (5min idle)             │
//                     │                  │
//                     ▼                  │
//                +----------+            │
//                |   idle   |────────────┘
//                +----+--+--+
//                     │  │
//          T5 (end)   │  │  T6/T7 (pagehide-from-idle / orphan cron 6h)
//                     │  │
//                     ▼  ▼
//             +-------+  +------------+
//             | ended |  | abandoned  |
//             +-------+  +------------+
//
// All five transitions live in this module per ADR-0005 single-owner
// invariant; routes / boss handlers MUST NOT update learning_session for
// type='conversation' directly.

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

// ---------- idleConversation (T4) ----------

/**
 * active → idle. Called by `promote_conversation_idle` boss handler after the
 * 5min no-user-input threshold. No-op-safe: if another caller already moved
 * the session to a different status (e.g. T2b race), throws 409 — handler
 * skips per design §"Edge cases" E10.
 */
export async function idleConversation(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadConversationSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError(
        'not_found',
        `learning_session ${sessionId} (type=conversation) not found`,
        404,
      );
    }
    assertFromState(
      current.status,
      ['active'] as const,
      sessionId,
      'Conversation.idleConversation',
    );

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'idle',
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'conversation.idle',
      payload: { idle_at: now.toISOString() },
    });
  });
}

// ---------- endConversation (T5) ----------

/**
 * active|idle → ended. Used by explicit user close, drawer unmount, and
 * pagehide-while-active (E5: pagehide-while-idle uses abandonConversation).
 */
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
    assertFromState(
      current.status,
      ['active', 'idle'] as const,
      sessionId,
      'Conversation.endConversation',
    );

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
      payload: { from_status: current.status },
    });
  });
}

// ---------- abandonConversation (T6/T7) ----------

export type AbandonReason = 'orphan_cron' | 'pagehide_idle' | 'pagehide_explicit';

/**
 * active|idle → abandoned. Triggered by orphan cron (>6h) or sendBeacon with
 * `{status:'abandoned'}` (typically pagehide-while-drawer-showed-idle).
 */
export async function abandonConversation(
  db: Db,
  sessionId: string,
  reason: AbandonReason = 'orphan_cron',
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadConversationSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError(
        'not_found',
        `learning_session ${sessionId} (type=conversation) not found`,
        404,
      );
    }
    assertFromState(
      current.status,
      ['active', 'idle'] as const,
      sessionId,
      'Conversation.abandonConversation',
    );

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'abandoned',
        ended_at: now,
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'conversation.abandoned',
      payload: { from_status: current.status, reason },
    });
  });
}

// ---------- assertAcceptingTurns (T2 + T2b inline resume) ----------

/**
 * Verify the conversation accepts a new user turn. If the session is `idle`,
 * inline-resume it (idle → active) inside the same transaction. Returns
 * `{ goalId, wasIdle }` so the caller can communicate the resume to the UI
 * (was_idle=true → drawer clears its idle banner).
 *
 * Terminal states (ended/abandoned) throw 409.
 */
export async function assertAcceptingTurns(
  db: Db,
  sessionId: string,
): Promise<{ goalId: string | null; wasIdle: boolean }> {
  return db.transaction(async (tx) => {
    const current = await loadConversationSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError(
        'not_found',
        `learning_session ${sessionId} (type=conversation) not found`,
        404,
      );
    }
    if (current.status !== 'active' && current.status !== 'idle') {
      throw new ApiError(
        'conflict',
        `learning_session ${sessionId} status=${current.status}, expected active|idle`,
        409,
      );
    }

    let wasIdle = false;
    if (current.status === 'idle') {
      wasIdle = true;
      const now = new Date();
      await tx
        .update(learning_session)
        .set({
          status: 'active',
          updated_at: now,
          version: sql`${learning_session.version} + 1`,
        })
        .where(eq(learning_session.id, sessionId));

      await writeJobEvent(tx, {
        business_table: SESSION_TABLE,
        business_id: sessionId,
        event_type: 'conversation.resumed',
        payload: { resumed_at: now.toISOString() },
      });
    }
    return { goalId: current.goal_id, wasIdle };
  });
}

// ---------- assertActive (deprecated) ----------

/**
 * @deprecated YUK-14 — use `assertAcceptingTurns` instead, which also accepts
 *   `idle` (auto-resume) and reports wasIdle to the caller. Kept temporarily
 *   to keep this PR's diff focused; a follow-up PR removes this fn entirely.
 *   New call sites MUST use `assertAcceptingTurns`.
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
