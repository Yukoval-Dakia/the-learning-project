import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { writeJobEvent } from '@/kernel/job-events';
import { assertFromState } from '@/kernel/learning-session-guard';
import { COPILOT_REUSE_WINDOW_MS } from '@/kernel/limits';
import { lockCopilotSessionSelection } from '@/kernel/locks/copilot-session-selection-lock';
import { requestCopilotRunCancellation } from './copilot-run-cancellation';
import { acquireCopilotSessionQueueLock, listOpenCopilotRunIds } from './durable-dispatch';

// Conversation session lifecycle for Copilot and teaching.
//
// State machine (ADR-0008 + docs/design/2026-05-24-teaching-idle-state-machine.md):
//   active → idle             T4: 5min without a user message (promote_conversation_idle)
//   idle → active             T2b: next user turn resumes in place
//   active|idle → ended       T5: endConversation
//   active|idle → abandoned   T6/T7: abandonConversation / 6h orphan cron
//
// All conversation transitions live in this module per ADR-0005; routes and
// boss handlers must not update learning_session(type='conversation') directly.

const SESSION_TABLE = 'learning_session' as const;

async function loadConversationSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{
  status: string;
  goal_id: string | null;
  version: number;
  entrypoint: string | null;
  deletion_requested_at: Date | null;
  deleted_at: Date | null;
} | null> {
  const rows = await tx.execute<{
    status: string;
    goal_id: string | null;
    version: number;
    entrypoint: string | null;
    deletion_requested_at: Date | null;
    deleted_at: Date | null;
  }>(
    sql`SELECT status, goal_id, version, entrypoint, deletion_requested_at, deleted_at FROM learning_session WHERE id = ${sessionId} AND type = 'conversation' FOR UPDATE`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    goal_id: row.goal_id,
    version: row.version,
    entrypoint: row.entrypoint,
    deletion_requested_at: row.deletion_requested_at,
    deleted_at: row.deleted_at,
  };
}

function assertNotDeleted(
  sessionId: string,
  row: { deletion_requested_at: Date | null; deleted_at: Date | null },
): void {
  if (row.deletion_requested_at || row.deleted_at) {
    throw new ApiError('conflict', `Copilot conversation ${sessionId} is deleted`, 409);
  }
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

// ---------- findOrCreateCopilotConversation (AF S3a / YUK-203 U3) ----------

/**
 * Copilot session envelope (AF spec §1.5 + §7 S3a). Returns the durable
 * `learning_session(type='conversation')` this Copilot turn belongs to, creating
 * one only when no live session can be reused.
 *
 * Reuse predicate lives in `findReusableCopilotConversation`. Copilot sessions
 * carry `goal_id = null`; teaching's `startConversation` sets it.
 *
 * Both select and insert run in one transaction, and an idle reuse is resumed to
 * active here so the row never stays stale.
 */
// The reuse window lives in @/core/limits so the UI bootstrap auto-selection and
// this lifecycle predicate use the same constant.

/**
 * Resolve the single live Copilot session this surface would reuse right now,
 * or null. Shared by `findOrCreateCopilotConversation` (find-vs-create) and the
 * turns reader (replay scoping), so "live" cannot drift between them.
 *
 * A match is entrypoint='copilot', status active|idle, updated within the reuse
 * window. Read-only; callers that mutate wrap it in their own transaction.
 */
export async function findReusableCopilotConversation(
  db: Db | Tx,
  opts: { now?: Date } = {},
): Promise<{ id: string; status: string } | null> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - COPILOT_REUSE_WINDOW_MS);

  const candidates = await db
    .select({ id: learning_session.id, status: learning_session.status })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'conversation'),
        // Teaching's startConversation also writes type='conversation' (entrypoint
        // null, goal_id set); without this filter a live teaching session could be
        // reused here and pollute teaching's event stream.
        eq(learning_session.entrypoint, 'copilot'),
        inArray(learning_session.status, ['active', 'idle']),
        gte(learning_session.updated_at, cutoff),
        isNull(learning_session.deletion_requested_at),
        isNull(learning_session.deleted_at),
      ),
    )
    .orderBy(desc(learning_session.updated_at))
    .limit(1);

  return candidates[0] ?? null;
}

export interface CopilotConversationSummary {
  id: string;
  status: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

async function insertCopilotConversation(tx: Tx, now: Date): Promise<string> {
  const sessionId = createId();
  await tx.insert(learning_session).values({
    id: sessionId,
    type: 'conversation',
    status: 'active',
    source_document_id: null,
    source_asset_ids: [],
    entrypoint: 'copilot',
    warnings: [],
    error_message: null,
    summary_md: null,
    goal_id: null,
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: sessionId,
    event_type: 'conversation.started',
    payload: { surface: 'copilot' },
  });
  return sessionId;
}

export async function createCopilotConversation(
  db: Db,
  opts: { now?: Date } = {},
): Promise<{ sessionId: string; session: CopilotConversationSummary }> {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const sessionId = await insertCopilotConversation(tx, now);
    return {
      sessionId,
      session: {
        id: sessionId,
        status: 'active',
        title: null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    };
  });
}

export async function listCopilotConversations(
  db: Db,
  opts: { limit?: number } = {},
): Promise<CopilotConversationSummary[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 100);
  const rows = await db
    .select({
      id: learning_session.id,
      status: learning_session.status,
      title: learning_session.summary_md,
      created_at: learning_session.created_at,
      updated_at: learning_session.updated_at,
    })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'conversation'),
        eq(learning_session.entrypoint, 'copilot'),
        isNull(learning_session.deletion_requested_at),
        isNull(learning_session.deleted_at),
      ),
    )
    .orderBy(desc(learning_session.updated_at), desc(learning_session.id))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

export async function getCopilotConversation(
  db: Db | Tx,
  sessionId: string,
): Promise<{ id: string; status: string } | null> {
  const rows = await db
    .select({ id: learning_session.id, status: learning_session.status })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.id, sessionId),
        eq(learning_session.type, 'conversation'),
        eq(learning_session.entrypoint, 'copilot'),
        isNull(learning_session.deletion_requested_at),
        isNull(learning_session.deleted_at),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Admission may lock the lifecycle row against end/abandon through its own commit. */
export async function isLiveCopilotConversation(
  db: Db | Tx,
  sessionId: string,
  lock = false,
): Promise<boolean> {
  const query = db
    .select({ id: learning_session.id })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.id, sessionId),
        eq(learning_session.type, 'conversation'),
        eq(learning_session.entrypoint, 'copilot'),
        inArray(learning_session.status, ['active', 'idle']),
        isNull(learning_session.deletion_requested_at),
        isNull(learning_session.deleted_at),
      ),
    );
  const rows = lock ? await query.for('update') : await query;
  return rows.length > 0;
}

export async function findOrCreateCopilotConversation(
  db: Db,
  opts: { now?: Date; sessionId?: string } = {},
): Promise<{ sessionId: string; created: boolean }> {
  const now = opts.now ?? new Date();

  return db.transaction(async (tx) => {
    await lockCopilotSessionSelection(tx);
    if (opts.sessionId) {
      const selected = await tx
        .select({
          id: learning_session.id,
          status: learning_session.status,
          deletion_requested_at: learning_session.deletion_requested_at,
          deleted_at: learning_session.deleted_at,
        })
        .from(learning_session)
        .where(
          and(
            eq(learning_session.id, opts.sessionId),
            eq(learning_session.type, 'conversation'),
            eq(learning_session.entrypoint, 'copilot'),
          ),
        )
        .limit(1);
      const current = selected[0];
      if (!current) throw new ApiError('not_found', 'Copilot conversation not found', 404);
      assertNotDeleted(current.id, current);
      if (current.status !== 'active' && current.status !== 'idle') {
        throw new ApiError('conflict', `Copilot conversation is ${current.status}`, 409);
      }
      await tx
        .update(learning_session)
        .set({
          status: 'active',
          updated_at: now,
          version: sql`${learning_session.version} + 1`,
        })
        .where(eq(learning_session.id, current.id));
      if (current.status === 'idle') {
        await writeJobEvent(tx, {
          business_table: SESSION_TABLE,
          business_id: current.id,
          event_type: 'conversation.resumed',
          payload: { resumed_at: now.toISOString(), surface: 'copilot' },
        });
      }
      return { sessionId: current.id, created: false };
    }
    // Same predicate as the turns reader, so "live" cannot drift between them.
    const existing = await findReusableCopilotConversation(tx, { now });
    if (existing) {
      // Reflect the live turn immediately, mirroring assertAcceptingTurns.
      if (existing.status === 'idle') {
        await tx
          .update(learning_session)
          .set({
            status: 'active',
            updated_at: now,
            version: sql`${learning_session.version} + 1`,
          })
          .where(eq(learning_session.id, existing.id));

        await writeJobEvent(tx, {
          business_table: SESSION_TABLE,
          business_id: existing.id,
          event_type: 'conversation.resumed',
          payload: { resumed_at: now.toISOString(), surface: 'copilot' },
        });
      } else {
        // An already-active session is live right now, so touch updated_at: the
        // reuse window must be measured from the last turn, not from creation or
        // resume time, or a long conversation would split mid-use after 24h.
        await tx
          .update(learning_session)
          .set({
            updated_at: now,
            version: sql`${learning_session.version} + 1`,
          })
          .where(eq(learning_session.id, existing.id));
      }
      return { sessionId: existing.id, created: false };
    }

    const sessionId = await insertCopilotConversation(tx, now);
    return { sessionId, created: true };
  });
}

// ---------- idleConversation (T4) ----------

/**
 * active → idle (T4). `promote_conversation_idle` calls this after the 5min
 * no-user-input threshold. If a concurrent close/abandon (T5/T6/T7) or an
 * overlapping promote already moved the session before this transaction takes
 * the row lock, the status assert throws 409 and the handler skips.
 */
export async function idleConversation(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCopilotSessionSelection(tx);
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
 * active|idle → ended (T5). E5: pagehide while the drawer is idle uses
 * abandonConversation instead, so walking away is not recorded as an explicit end.
 */
export async function endConversation(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCopilotSessionSelection(tx);
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
 * active|idle → abandoned (T6/T7). The 6h orphan cron sweeps through
 * `abandonOrphanConversationTx`; the reason is recorded on the event payload.
 */
export async function abandonConversation(
  db: Db,
  sessionId: string,
  reason: AbandonReason = 'orphan_cron',
): Promise<void> {
  await db.transaction(async (tx) => {
    await abandonConversationTx(tx, { sessionId, reason });
  });
}

async function abandonConversationTx(
  tx: Tx,
  { sessionId, reason }: { sessionId: string; reason: AbandonReason },
): Promise<{ fromVersion: number; toVersion: number }> {
  await lockCopilotSessionSelection(tx);
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
  return { fromVersion: current.version, toVersion: current.version + 1 };
}

export class ConversationOrphanStateError extends Error {}
export type OrphanConversationCandidate = {
  sessionId: string;
  selectedStartedAt: string;
  selectedVersion: number;
};
export type OrphanConversationResult =
  | { kind: 'abandoned'; fromVersion: number; toVersion: number }
  | { kind: 'skipped'; reason: 'missing' | 'terminal' | 'not-old' };

/** Orphan eligibility for the platform sweep tick: active or idle conversations older than its cutoff, in id order. */
export async function selectOrphanConversationCandidates(
  tx: Tx,
  cutoff: string,
): Promise<OrphanConversationCandidate[]> {
  return tx
    .select({
      sessionId: learning_session.id,
      selectedStartedAt: sql<string>`${learning_session.started_at}::text`,
      selectedVersion: learning_session.version,
    })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'conversation'),
        inArray(learning_session.status, ['active', 'idle']),
        sql`${learning_session.started_at} < ${cutoff}::timestamptz`,
      ),
    )
    .orderBy(learning_session.id);
}

export async function abandonOrphanConversationTx(
  tx: Tx,
  input: { sessionId: string; cutoff: string },
): Promise<OrphanConversationResult> {
  await lockCopilotSessionSelection(tx);
  const current = await loadConversationSessionForUpdate(tx, input.sessionId);
  if (!current) return { kind: 'skipped', reason: 'missing' };
  if (current.status === 'ended' || current.status === 'abandoned')
    return { kind: 'skipped', reason: 'terminal' };
  if (current.status !== 'active' && current.status !== 'idle')
    throw new ConversationOrphanStateError(`Corrupt conversation status: ${current.status}`);
  const [age] = await tx.execute(sql`select started_at < ${input.cutoff}::timestamptz as old
    from learning_session where id = ${input.sessionId} and type = 'conversation'`);
  if (age?.old !== true) return { kind: 'skipped', reason: 'not-old' };
  return {
    kind: 'abandoned',
    ...(await abandonConversationTx(tx, { sessionId: input.sessionId, reason: 'orphan_cron' })),
  };
}

// ---------- assertAcceptingTurns (T2 + T2b inline resume) ----------

/**
 * Verify the conversation accepts a user turn; idle is resumed to active inside
 * the same transaction. Returns `{ goalId, wasIdle }` so the UI can clear its
 * idle banner. Terminal states (ended/abandoned) throw 409.
 */
export async function assertAcceptingTurns(
  db: Db,
  sessionId: string,
): Promise<{ goalId: string | null; wasIdle: boolean }> {
  return db.transaction(async (tx) => {
    await lockCopilotSessionSelection(tx);
    const current = await loadConversationSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError(
        'not_found',
        `learning_session ${sessionId} (type=conversation) not found`,
        404,
      );
    }
    assertNotDeleted(sessionId, current);
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

// ---------- assertActive (strict no-resume variant) ----------

/**
 * Require an already-active conversation without changing lifecycle state.
 * Unlike `assertAcceptingTurns`, this never resumes idle; accept-chip PIN 9
 * needs the 409-on-ended, no-side-effect contract.
 */
export async function assertActive(db: Db, sessionId: string): Promise<{ goalId: string | null }> {
  const rows = await db
    .select({
      status: learning_session.status,
      goal_id: learning_session.goal_id,
      deletion_requested_at: learning_session.deletion_requested_at,
      deleted_at: learning_session.deleted_at,
    })
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
  assertNotDeleted(sessionId, row);
  if (row.status !== 'active') {
    throw new ApiError(
      'conflict',
      `learning_session ${sessionId} status=${row.status}, expected active`,
      409,
    );
  }
  return { goalId: row.goal_id };
}

// ---------- requestCopilotConversationDeletion (hard delete) ----------
//
// Durable sequence: revoke access (deletion_requested_at commits first, so a
// crash after this point is still recoverable) → cancel every open durable run
// → persist the tombstone (deleted_at) only when no open run remains. The
// workspace sweep reads these two columns and removes the owner's directory;
// copilot code never touches agent-workspace state directly.
// Stop/close never enters this path — they keep their cancel/subscription
// semantics.

export type CopilotConversationDeletionResult = {
  session_id: string;
  status: 'deleting' | 'deleted';
};

/**
 * First phase commits the revocation; later phases are idempotent so a retry
 * after a crash simply re-cancels and re-checks. `deleting` means in-flight
 * runs have not settled yet — `finalizePendingConversationDeletions` (called
 * by the reconcile job) completes the tombstone once they do.
 */
export async function requestCopilotConversationDeletion(
  db: Db,
  sessionId: string,
): Promise<CopilotConversationDeletionResult> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await lockCopilotSessionSelection(tx);
    // The session-queue lock is the same one admission holds while writing a
    // run's acceptance evidence. Taking it before the session row means a
    // racing send either commits first (visible to our open-runs list, then
    // cancelled) or blocks until the revoke lands and is rejected at the gate.
    await acquireCopilotSessionQueueLock(tx, sessionId);
    const current = await loadConversationSessionForUpdate(tx, sessionId);
    if (current?.entrypoint !== 'copilot') {
      throw new ApiError('not_found', 'Copilot conversation not found', 404);
    }
    if (current.deleted_at || current.deletion_requested_at) return;
    await tx
      .update(learning_session)
      .set({
        deletion_requested_at: now,
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'conversation.deletion_requested',
      payload: { requested_at: now.toISOString(), surface: 'copilot' },
    });
  });

  for (const runId of await listOpenCopilotRunIds(db, sessionId)) {
    try {
      await requestCopilotRunCancellation(db, runId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) continue;
      throw error;
    }
  }

  if ((await listOpenCopilotRunIds(db, sessionId)).length === 0) {
    await markCopilotConversationDeleted(db, sessionId);
    return { session_id: sessionId, status: 'deleted' };
  }
  return { session_id: sessionId, status: 'deleting' };
}

/** Persist the tombstone. Requires the revocation to exist; safe to repeat.
 *  Under the queue lock the open-runs recheck is authoritative: a still-open
 *  run simply keeps the session `deleting` instead of stranding it. */
export async function markCopilotConversationDeleted(db: Db, sessionId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockCopilotSessionSelection(tx);
    await acquireCopilotSessionQueueLock(tx, sessionId);
    const current = await loadConversationSessionForUpdate(tx, sessionId);
    if (current?.entrypoint !== 'copilot') {
      throw new ApiError('not_found', 'Copilot conversation not found', 404);
    }
    if (current.deleted_at) return false;
    if (!current.deletion_requested_at) {
      throw new ApiError('conflict', 'Copilot conversation deletion was not requested', 409);
    }
    if ((await listOpenCopilotRunIds(tx, sessionId)).length > 0) return false;
    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        deleted_at: now,
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'conversation.deleted',
      payload: { deleted_at: now.toISOString(), surface: 'copilot' },
    });
    return true;
  });
}

/**
 * Drain-complete pass for the reconcile job: tombstone every revoking
 * conversation whose runs have all settled. Bounded and idempotent — a slow
 * run simply keeps the session in `deleting` until a later pass.
 */
export async function finalizePendingConversationDeletions(
  db: Db,
  { limit = 20 }: { limit?: number } = {},
): Promise<number> {
  const pending = await db
    .select({ id: learning_session.id })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'conversation'),
        eq(learning_session.entrypoint, 'copilot'),
        sql`${learning_session.deletion_requested_at} IS NOT NULL`,
        isNull(learning_session.deleted_at),
      ),
    )
    .orderBy(learning_session.deletion_requested_at)
    .limit(limit);
  let finalized = 0;
  for (const { id } of pending) {
    // Re-cancel every pass: a run admitted just before the revoke commit is
    // also why the tombstone waits, so convergence must keep pushing it.
    for (const runId of await listOpenCopilotRunIds(db, id)) {
      try {
        await requestCopilotRunCancellation(db, runId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) continue;
        throw error;
      }
    }
    if (await markCopilotConversationDeleted(db, id)) finalized += 1;
  }
  return finalized;
}
