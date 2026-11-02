import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';

import { getConfigFlag } from '@/core/config/store';
import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { writeJobEvent } from '@/kernel/job-events';

import { assertFromState } from '@/kernel/learning-session-guard';

// LearningSession.Placement.* — cold-start inc-B (YUK-468) bounded first-session
// envelope (docs/design/2026-06-20-cold-start-day-one-design.md §2 步骤3 / §5 inc-B).
//
// State machine: started → completed | abandoned. There is no pause/resume: an
// interrupted probe is abandoned and the user starts a fresh one.
//
// These transitions are state envelopes only; per-question judge/θ̂ writes belong
// to the placement submit route (judge outside the θ̂ tx, θ̂ write inside it).
// No domain events are written here — job_events only.
//
// PLACEMENT_PROBE_ENABLED gates the whole entrypoint. When false no probe is
// created, so the daily-stream and review paths are unchanged; the flag never
// touches steady-state selection. It stays a function rather than a const
// because envPinned means the dashboard cannot silently flip it, while callers
// still need the runtime value (YUK-1007).
export function placementProbeEnabled(): boolean {
  return getConfigFlag('PLACEMENT_PROBE_ENABLED');
}

const SESSION_TABLE = 'learning_session' as const;

export type PlacementSessionStatus = 'started' | 'completed' | 'abandoned';

export type PlacementSessionTransition = {
  previousStatus: PlacementSessionStatus;
  status: PlacementSessionStatus;
  changed: boolean;
  allowedStatuses: PlacementSessionStatus[];
};

const PLACEMENT_ALLOWED_TARGETS: Record<PlacementSessionStatus, PlacementSessionStatus[]> = {
  started: ['completed', 'abandoned'],
  completed: [],
  abandoned: [],
};

// Row-lock the probe for the surrounding tx and return its server-side scope.
// Exported so /next serialises concurrent POSTs on one probe and reads the
// persisted scope instead of trusting the client body (YUK-470).
export async function loadPlacementSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{
  status: string;
  scopeKnowledgeIds: string[] | null;
  // Onboarding self-report captured at start; read under the same row lock so
  // /next can apply ordering and cap without trusting the client to resend it.
  leanings: string[] | null;
  pace: string | null;
} | null> {
  const rows = await tx.execute<{
    status: string;
    scope_knowledge_ids: string[] | null;
    placement_leanings: string[] | null;
    placement_pace: string | null;
  }>(
    sql`SELECT status, scope_knowledge_ids, placement_leanings, placement_pace FROM learning_session WHERE id = ${sessionId} AND type = 'placement' FOR UPDATE`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    scopeKnowledgeIds: row.scope_knowledge_ids ?? null,
    leanings: row.placement_leanings ?? null,
    pace: row.placement_pace ?? null,
  };
}

// ---------- startPlacementSession ----------

export type StartPlacementSessionParams = {
  /** Goal whose KG subgraph scopes the probe; omitted for a subject-only probe. */
  goalId?: string | null;
  /**
   * Resolved KC set persisted at start so /next reads server state instead of a
   * client-supplied list. Covers both goal-scoped and explicit-knowledgeIds probes
   * (the latter have a null goal_id); the start handler always supplies it.
   */
  knowledgeIds?: readonly string[];
  /**
   * Onboarding self-report persisted on the probe. Both values are ordering/amount
   * only and never feed θ̂/p(L)/FSRS (YUK-480); omitted → NULL for back-compat.
   */
  leanings?: readonly string[];
  pace?: string | null;
};

/**
 * Create a fresh placement session (type='placement', status='started'). The
 * submit route chains per-question judge/θ̂ events to the returned id.
 */
export async function startPlacementSession(
  db: Db | Tx,
  params: StartPlacementSessionParams = {},
): Promise<{ sessionId: string }> {
  return db.transaction(async (tx) => {
    const sessionId = createId();
    const now = new Date();
    await tx.insert(learning_session).values({
      id: sessionId,
      type: 'placement',
      status: 'started',
      source_document_id: null,
      source_asset_ids: [],
      entrypoint: null,
      warnings: [],
      error_message: null,
      summary_md: null,
      goal_id: params.goalId ?? null,
      artifact_id: null,
      // Null only when the caller omits it (legacy back-compat); the start handler
      // always passes the resolved set (YUK-470).
      scope_knowledge_ids: params.knowledgeIds ? Array.from(params.knowledgeIds) : null,
      // Empty leanings normalizes to NULL (no preference); ordering/amount only.
      placement_leanings:
        params.leanings && params.leanings.length > 0 ? Array.from(params.leanings) : null,
      placement_pace: params.pace ?? null,
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'placement.started',
      payload: {},
    });

    return { sessionId };
  });
}

// ---------- completePlacementSession ----------

/**
 * started → completed. Called when the probe hits its count cap or SE convergence
 * (placement-termination.ts).
 */
export async function completePlacementSession(db: Db, sessionId: string): Promise<void> {
  await applyPlacementSessionTransition(db, sessionId, 'completed', false);
}

// ---------- abandonPlacementSession ----------

/**
 * started → abandoned. Distinct from `completed` so the timeline can separate
 * "walked away" from "finished"; per-question events stay chained by session_id.
 *
 * Stale probes (>6h) are swept by `prune_orphan_placement_sessions`, a sibling of
 * the review/conversation sweeps.
 */
export async function abandonPlacementSession(db: Db, sessionId: string): Promise<void> {
  await applyPlacementSessionTransition(db, sessionId, 'abandoned', false);
}

async function applyPlacementSessionTransition(
  db: Db,
  sessionId: string,
  target: Exclude<PlacementSessionStatus, 'started'>,
  idempotent: boolean,
): Promise<PlacementSessionTransition> {
  return db.transaction((tx) =>
    applyPlacementSessionTransitionTx(tx, { sessionId, target, idempotent }),
  );
}

async function applyPlacementSessionTransitionTx(
  tx: Tx,
  {
    sessionId,
    target,
    idempotent,
  }: {
    sessionId: string;
    target: Exclude<PlacementSessionStatus, 'started'>;
    idempotent: boolean;
  },
): Promise<PlacementSessionTransition> {
  const current = await loadPlacementSessionForUpdate(tx, sessionId);
  if (!current) {
    throw new ApiError(
      'not_found',
      `learning_session ${sessionId} (type=placement) not found`,
      404,
    );
  }

  const previousStatus = current.status as PlacementSessionStatus;
  if (previousStatus === target && idempotent) {
    return {
      previousStatus,
      status: target,
      changed: false,
      allowedStatuses: PLACEMENT_ALLOWED_TARGETS[target],
    };
  }
  assertFromState(
    current.status,
    ['started'] as const,
    sessionId,
    `Placement.transitionPlacementSession(${target})`,
  );

  const now = new Date();
  await tx
    .update(learning_session)
    .set({
      status: target,
      ended_at: now,
      updated_at: now,
      version: sql`${learning_session.version} + 1`,
    })
    .where(eq(learning_session.id, sessionId));

  await writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: sessionId,
    event_type: `placement.${target}`,
    payload: {},
  });

  return {
    previousStatus,
    status: target,
    changed: true,
    allowedStatuses: PLACEMENT_ALLOWED_TARGETS[target],
  };
}

export class PlacementOrphanStateError extends Error {}
export type OrphanPlacementResult =
  | { kind: 'abandoned'; fromVersion: number; toVersion: number }
  | { kind: 'skipped'; reason: 'missing' | 'terminal' | 'not-old' };

export async function abandonOrphanPlacementTx(
  tx: Tx,
  input: { sessionId: string; cutoff: string },
): Promise<OrphanPlacementResult> {
  const current = await loadPlacementSessionForUpdate(tx, input.sessionId);
  if (!current) return { kind: 'skipped', reason: 'missing' };
  if (current.status === 'completed' || current.status === 'abandoned')
    return { kind: 'skipped', reason: 'terminal' };
  if (current.status !== 'started')
    throw new PlacementOrphanStateError(`Corrupt placement status: ${current.status}`);
  const [age] = await tx.execute<{ old: boolean; version: number }>(sql`select version,
    started_at < ${input.cutoff}::timestamptz as old from learning_session
    where id = ${input.sessionId} and type = 'placement'`);
  if (age?.old !== true) return { kind: 'skipped', reason: 'not-old' };
  await applyPlacementSessionTransitionTx(tx, {
    sessionId: input.sessionId,
    target: 'abandoned',
    idempotent: false,
  });
  return { kind: 'abandoned', fromVersion: age.version, toVersion: age.version + 1 };
}

/** Idempotent target-state transition used by PATCH /api/placement-sessions/:id. */
export async function transitionPlacementSession(
  db: Db,
  sessionId: string,
  target: Exclude<PlacementSessionStatus, 'started'>,
): Promise<PlacementSessionTransition> {
  return applyPlacementSessionTransition(db, sessionId, target, true);
}
