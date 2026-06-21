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
//
// YUK-473 Slice 3: env-driven so the flip is CONFIG, not code (defer-flip-not-build).
// Default false → prod stays dark until the env var is set; dev opts in via
// `.env.local` (PLACEMENT_PROBE_ENABLED=true). Same shape as the auto-enroll flag.
export const PLACEMENT_PROBE_ENABLED = process.env.PLACEMENT_PROBE_ENABLED === 'true';

const SESSION_TABLE = 'learning_session' as const;

// Row-lock the placement session for the duration of the surrounding tx (FOR UPDATE). Returns
// the status AND the server-side scope (scope_knowledge_ids) captured at start. Exported so the
// /next route can serialize concurrent POSTs on the same probe (two concurrent /next must not
// both pass the started check and serve the same question — YUK-470 part 1) and read the
// persisted scope instead of trusting the client body (YUK-470 part 2). Mirrors review.ts's
// loadReviewSessionForUpdate locking idiom.
export async function loadPlacementSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{ status: string; scopeKnowledgeIds: string[] | null } | null> {
  const rows = await tx.execute(
    sql`SELECT status, scope_knowledge_ids FROM learning_session WHERE id = ${sessionId} AND type = 'placement' FOR UPDATE`,
  );
  const arr = rows as unknown as Array<{ status: string; scope_knowledge_ids: string[] | null }>;
  const row = arr[0];
  if (!row) return null;
  return { status: row.status, scopeKnowledgeIds: row.scope_knowledge_ids ?? null };
}

// ---------- startPlacementSession ----------

export type StartPlacementSessionParams = {
  /**
   * The goal whose KG subgraph scopes this probe (the goal's scope_knowledge_ids
   * determine which KCs the frontier walks). Optional for a subject-only probe.
   */
  goalId?: string | null;
  /**
   * YUK-470 — the resolved goal-subgraph KC set this probe walks, captured at start and
   * persisted server-side on the session (scope_knowledge_ids). The /next route reads this
   * instead of trusting a client-supplied knowledgeIds body. Covers BOTH probe shapes
   * uniformly (goal-scoped AND explicit-knowledgeIds) — goal_id alone would not, since
   * explicit-knowledgeIds probes have a null goal_id. Optional for back-compat; the start
   * handler always supplies the resolved set.
   */
  knowledgeIds?: readonly string[];
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
      // Persist the resolved probe scope server-side (YUK-470). null only when the caller
      // omits it (legacy/test back-compat) — the start handler always passes the resolved set.
      scope_knowledge_ids: params.knowledgeIds ? Array.from(params.knowledgeIds) : null,
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
 * NOTE: stale started placement probes (>6h) are swept by the `prune_orphan_placement_sessions`
 * cron (YUK-470 orphan-sweep leg, src/server/boss/handlers/), a sibling of the review/conversation
 * sweeps. It is a no-op today (PLACEMENT_PROBE_ENABLED is false → no probe is ever created),
 * landing the go-live prerequisite ahead of the flag flip.
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
