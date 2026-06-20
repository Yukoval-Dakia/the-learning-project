import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError } from '@/server/http/errors';

import { assertFromState } from './guards';

// LearningSession.Placement.* — cold-start inc-B (YUK-468) bounded first-session
// state envelope. docs/design/2026-06-20-cold-start-day-one-design.md §2 步骤3 / §5 inc-B.
//
// State machine (narrower than review — NO pause/resume/reopen):
//   started → completed | abandoned
//
// A placement probe is a ONE-SHOT bounded session (~8 questions/subject, §6 Q1):
// per item it selects (KLP cold-start) → judges → tightens θ̂/precision/p(L), then
// terminates on a count cap (or optional θ SE convergence — see placement-termination.ts).
// Unlike review there is NO paused/resumed: an interrupted probe is abandoned (the user
// can re-run a fresh probe), so the state machine stays minimal.
//
// Placement sessions are state envelopes ONLY. Per-question judge/θ̂ writes are done by
// the placement submit route (PR-2) via the SAME updateThetaForAttempt path as solo review
// (three-axis orthogonality red line — judge OUTSIDE the θ̂ tx, θ̂ write INSIDE it). NO
// domain event writes happen inside these transitions — they are purely state-tracking,
// mirroring review.ts.
//
// ── DARK-SHIP FLAG ──────────────────────────────────────────────────────────────────────
// PLACEMENT_PROBE_ENABLED gates the entire placement entrypoint. While false (default), the
// placement route (PR-2) is unreachable and NO placement session is ever created → the live
// daily-stream / review paths are byte-identical (this flag's only effect is whether the
// cold-DB /today trigger — a Phase-3 UI surface — may start a probe). Flipping it on is the
// go-live decision for the cold-start first-session journey; it does NOT touch steady-state
// selection (softmax-selection / composeDailyStream are not read here). Mirror of the
// EARLY_KLP_ENABLED dark-ship pattern (src/core/selection-signals.ts).
export const PLACEMENT_PROBE_ENABLED = false;

const SESSION_TABLE = 'learning_session' as const;

async function loadPlacementSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{ status: string } | null> {
  const rows = await tx.execute(
    sql`SELECT status FROM learning_session WHERE id = ${sessionId} AND type = 'placement' FOR UPDATE`,
  );
  const arr = rows as unknown as Array<{ status: string }>;
  const row = arr[0];
  if (!row) return null;
  return { status: row.status };
}

// ---------- startPlacementSession ----------

export type StartPlacementSessionParams = {
  /**
   * The goal whose KG subgraph scopes this probe (the goal's scope_knowledge_ids
   * determine which KCs the frontier walks). Optional for a subject-only probe.
   */
  goalId?: string | null;
};

/**
 * Create a fresh placement session (type='placement', status='started').
 *
 * @returns the new sessionId. The placement route (PR-2) writes per-question judge/θ̂
 *   events with session_id=<this id> through the shared submit path.
 */
export async function startPlacementSession(
  db: Db,
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
 * started → completed. Sets ended_at = now and bumps version. Called when the probe
 * hits a termination condition (count cap or SE convergence — placement-termination.ts).
 */
export async function completePlacementSession(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadPlacementSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError(
        'not_found',
        `learning_session ${sessionId} (type=placement) not found`,
        404,
      );
    }
    assertFromState(
      current.status,
      ['started'] as const,
      sessionId,
      'Placement.completePlacementSession',
    );

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'completed',
        ended_at: now,
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'placement.completed',
      payload: {},
    });
  });
}

// ---------- abandonPlacementSession ----------

/**
 * started → abandoned. Sets ended_at = now and bumps version. Distinct from `completed`
 * so the timeline can separate "probe you walked away from" from "probe that finished".
 * This is the single terminal transition for an interrupted probe. No data loss — any
 * per-question events already written stay chained by session_id.
 *
 * NOTE: the `prune_orphan_review_sessions` cron handler sweeps type='review' only (a sibling
 * handler sweeps conversation); extending an orphan sweep to stale started placement sessions
 * is a PR-2 follow-up (no orphans exist yet — PLACEMENT_PROBE_ENABLED is false, so no
 * placement session is ever created).
 */
export async function abandonPlacementSession(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadPlacementSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError(
        'not_found',
        `learning_session ${sessionId} (type=placement) not found`,
        404,
      );
    }
    assertFromState(
      current.status,
      ['started'] as const,
      sessionId,
      'Placement.abandonPlacementSession',
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
      event_type: 'placement.abandoned',
      payload: {},
    });
  });
}
