// YUK-761 — placement starter claim recovery sweeper (「建成不通电」收口 for YUK-452 Phase B).
//
// YUK-452 Phase B shipped the recovery INFRASTRUCTURE — `placement_starter_claim.next_reconcile_at`
// (migration 0074) plus the partial `placement_starter_claim_recovery_idx` on
// (next_reconcile_at, created_at) WHERE status IN (5 nonterminal states) — and then explicitly
// left it without a consumer (placement-start.ts:155-157: "there is NO background sweeper for
// pending_dispatch claims (the placement_starter_claim_recovery_idx supports one but none is
// wired yet)"). This module is that consumer. It is invoked from the tail of the existing
// `question_supply_nightly` job — no new cron surface.
//
// ── What is actually stranded (grounded state-machine reading) ────────────────────────────
// `pending_dispatch` — RE-DRIVE. A claim is committed by Transaction A of /api/placement/start
//   (materializePlacementStartersForGoal) and dispatched in a SEPARATE transaction afterwards.
//   If that dispatch throws (boss down, enqueue failure), the claim is committed but no quiz_gen
//   job exists, and the ONLY recovery is a subsequent /placement/start for the same goal. If the
//   learner never comes back, the goal's placement pool never fills — the crash window this
//   sweeper closes. Re-driving is safe because a pending_dispatch claim has spent NOTHING and
//   holds no pg-boss job: `dispatchPlacementStarterClaimTx` re-checks `status='pending_dispatch'`
//   under FOR UPDATE and CASes the pending→queued transition, so a concurrent /placement/start
//   and this sweeper cannot both dispatch.
//
// `retry_scheduled` — REAP ONLY, NEVER RE-DRIVE. This status is written by
//   `finishPlacementAttempt` on a NON-final delivery failure, and the pg-boss retry of the SAME
//   quiz_gen job (JOB_RETRY_LIMIT=2, 30s→60s backoff) is what re-drives it. Enqueuing a second
//   quiz_gen job here would run two paid generation batches against one claim — a direct
//   violation of the paid single-flight invariant that `placement_starter_claim_nonterminal_uq`
//   exists to protect. (`dispatchPlacementStarterClaimTx` would refuse it anyway: it returns
//   early for any status other than 'pending_dispatch'.) The REAL hazard on this status is the
//   opposite one: if the owning quiz_gen job dies without ever calling `finishPlacementAttempt`
//   again (worker killed, job expired past the 2h AGENT ceiling, DLQ'd), the claim zombies
//   non-terminal FOREVER — and because 'retry_scheduled' IS inside the
//   `placement_starter_claim_nonterminal_uq` predicate, that zombie permanently blocks every
//   later goal revision for the same (goal_id, subject_id): placement soft-stuck with no exit.
//   So the sweeper terminalizes a long-stale retry_scheduled claim as 'exhausted' (the same
//   terminal state `finishPlacementAttempt` writes when the final delivery fails).
//
// The other three nonterminal states inside the index predicate (queued / running / verifying)
// are NOT swept here: they are owned by a live pg-boss delivery and by the attempt lease/fence
// machinery. Widening the sweep to them needs its own lease-expiry analysis.
//
// ── Idempotency / anti-double-drive ───────────────────────────────────────────────────────
// Every claim is ACQUIRED by a conditional UPDATE (`WHERE id = ? AND status = ? AND
// next_reconcile_at <= now` RETURNING) that pushes `next_reconcile_at` forward BEFORE any paid
// work. A second sweeper pass in the same window matches zero rows and does nothing. That is
// also why the cursor bump deliberately does NOT touch `updated_at` or `version`: those mean
// "last STATE transition", and the retry_scheduled zombie reap reads `updated_at` as its
// staleness signal — bumping it on a scheduler visit would push the reap deadline out forever.

import type { Db } from '@/db/client';
import { goal, placement_starter_claim } from '@/db/schema';
import { dispatchPlacementStarterClaim } from '@/server/question-supply/placement-starter';
import { markPlacementStarterClaimTerminal } from '@/server/question-supply/placement-starter-store';
import { lockPlacementSupplyScopes } from '@/server/question-supply/placement-supply-lock';
import { PLACEMENT_PROBE_ENABLED } from '@/server/session/placement';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { resolveGoalPlacementScope } from './placement-scope';
import { selectNextPlacementItem } from './placement-select';

/**
 * How far forward the sweeper pushes `next_reconcile_at` when it acquires a claim. This is the
 * per-claim re-drive cooldown and it is INDEPENDENT of the host cron cadence — a manual job run,
 * a second worker, or a cron misfire cannot re-drive the same claim inside this window.
 */
export const PLACEMENT_STARTER_RECOVERY_BACKOFF_MS = 6 * 60 * 60_000;

/**
 * How long a claim must sit in `retry_scheduled` before it is declared a zombie and reaped.
 * Upper bound on a LEGITIMATE retry_scheduled window: the pg-boss retry delay (30s→60s backoff)
 * plus the time for the next delivery to acquire the attempt and flip the claim to 'running' —
 * seconds, not hours. Even a delivery that runs the full AGENT `expireInSeconds` ceiling (2h)
 * spends that time as 'running', not 'retry_scheduled'. 6h is therefore a ~2 order-of-magnitude
 * cushion over the real window: nothing healthy is ever reaped.
 */
export const PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS = 6 * 60 * 60_000;

/** Minimum forward movement of the cursor, so a visit always makes progress. */
const MIN_CURSOR_ADVANCE_MS = 60_000;

/**
 * Per-run cap. Mirrors `question_supply_nightly`'s own DEFAULT_MAX_PER_RUN=25 — each re-drive is
 * a paid quiz_gen batch, so a first run against a large backlog must not flood the paid queue.
 * Untouched claims keep their (already overdue) cursor and are picked up by the next run.
 */
const DEFAULT_MAX_PER_RUN = 25;

export interface PlacementStarterRecoveryResult {
  /** Overdue nonterminal claims returned by the recovery-index scan (after the per-run cap). */
  scanned: number;
  /** pending_dispatch claims re-driven into a real quiz_gen job. */
  redispatched: number;
  /** pending_dispatch claims whose paid admission was refused (pool already has an item, or the claim was superseded). */
  admissionSkipped: number;
  /** pending_dispatch claims whose re-dispatch threw; the claim stays pending for the next window. */
  redispatchFailed: number;
  /** retry_scheduled zombies terminalized as 'exhausted'. */
  reaped: number;
  /** retry_scheduled claims still inside the grace window; left for the owning pg-boss retry. */
  retryPending: number;
  /** Claims whose acquire CAS lost to a concurrent transition (already re-driven / terminalized elsewhere). */
  lost: number;
  /** Claims skipped because their goal row no longer exists (scope is unresolvable). */
  goalMissing: number;
  /** True when PLACEMENT_PROBE_ENABLED is off: paid re-dispatch is suppressed, zombie reaping still runs. */
  redispatchSuppressed: boolean;
}

export interface PlacementStarterRecoveryDeps {
  now?: Date;
  maxPerRun?: number;
  /** Seam for DB tests: defaults to the real boss-backed dispatch. */
  dispatch?: typeof dispatchPlacementStarterClaim;
  /** Seam for DB tests: defaults to the module-level dark-ship flag. */
  placementProbeEnabled?: boolean;
}

function emptyResult(redispatchSuppressed: boolean): PlacementStarterRecoveryResult {
  return {
    scanned: 0,
    redispatched: 0,
    admissionSkipped: 0,
    redispatchFailed: 0,
    reaped: 0,
    retryPending: 0,
    lost: 0,
    goalMissing: 0,
    redispatchSuppressed,
  };
}

/**
 * Sweep overdue placement starter claims: re-drive stranded `pending_dispatch` claims, reap
 * zombie `retry_scheduled` claims. Safe to call concurrently and safe to re-run — see the
 * idempotency note in the module header.
 */
export async function sweepStalePlacementStarterClaims(
  db: Db,
  deps: PlacementStarterRecoveryDeps = {},
): Promise<PlacementStarterRecoveryResult> {
  const now = deps.now ?? new Date();
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const dispatch = deps.dispatch ?? dispatchPlacementStarterClaim;
  // G-COST: the re-drive leg makes PAID generation happen automatically. While the placement
  // entrypoint is dark there is no consumer for a freshly filled placement pool, so paying for
  // one would be pure waste. Reaping is free and unblocks later revisions, so it always runs.
  const canRedispatch = deps.placementProbeEnabled ?? PLACEMENT_PROBE_ENABLED;
  const result = emptyResult(!canRedispatch);

  // Matches placement_starter_claim_recovery_idx exactly: the status filter is a subset of the
  // index's partial predicate, and the ORDER BY is its column order — oldest-overdue first.
  const due = await db
    .select()
    .from(placement_starter_claim)
    .where(
      and(
        inArray(placement_starter_claim.status, ['pending_dispatch', 'retry_scheduled']),
        lte(placement_starter_claim.next_reconcile_at, now),
      ),
    )
    .orderBy(
      asc(placement_starter_claim.next_reconcile_at),
      asc(placement_starter_claim.created_at),
    )
    .limit(maxPerRun);
  result.scanned = due.length;
  if (due.length === 0) return result;

  const zombieCutoff = new Date(now.getTime() - PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS);

  for (const claim of due) {
    if (claim.status === 'retry_scheduled') {
      await sweepRetryScheduled(db, claim, now, zombieCutoff, result);
      continue;
    }
    if (!canRedispatch) continue;
    await sweepPendingDispatch(db, claim, now, dispatch, result);
  }
  return result;
}

type ClaimRow = typeof placement_starter_claim.$inferSelect;

async function sweepPendingDispatch(
  db: Db,
  claim: ClaimRow,
  now: Date,
  dispatch: typeof dispatchPlacementStarterClaim,
  result: PlacementStarterRecoveryResult,
): Promise<void> {
  const [goalRow] = await db
    .select({
      scope: goal.scope_knowledge_ids,
      subjectId: goal.subject_id,
      scopeMode: goal.scope_mode,
    })
    .from(goal)
    .where(eq(goal.id, claim.goal_id))
    .limit(1);
  if (!goalRow) {
    // No goal row → resolveGoalPlacementScope would silently fall through to the tier-3
    // full-active-tree fallback and admit paid work against a scope the claim was never about.
    // Skip rather than invent a scope; the claim keeps its overdue cursor and is re-reported.
    result.goalMissing += 1;
    return;
  }
  const knowledgeIds = await resolveGoalPlacementScope(db, goalRow);

  // ACQUIRE (conditional UPDATE = CAS): push the cursor forward before any paid work, so a
  // concurrent sweeper / a re-run inside the window matches zero rows. Deliberately does NOT
  // bump updated_at or version — see the module header.
  const acquired = await db
    .update(placement_starter_claim)
    .set({ next_reconcile_at: new Date(now.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS) })
    .where(
      and(
        eq(placement_starter_claim.id, claim.id),
        eq(placement_starter_claim.status, 'pending_dispatch'),
        lte(placement_starter_claim.next_reconcile_at, now),
      ),
    )
    .returning({ id: placement_starter_claim.id });
  if (acquired.length !== 1) {
    result.lost += 1;
    return;
  }

  try {
    // Same admission contract as /api/placement/start's cold path: serialize against pool
    // promotion for this KC scope, then pay ONLY if the scope still has no eligible item.
    const jobId = await dispatch(db, claim.id, async (tx) => {
      await lockPlacementSupplyScopes(tx, knowledgeIds);
      return (await selectNextPlacementItem(tx, { knowledgeIds })) === null;
    });
    if (jobId) result.redispatched += 1;
    else result.admissionSkipped += 1;
  } catch (err) {
    // The claim keeps its bumped cursor and stays pending_dispatch — the next window retries it.
    // Per-claim isolation: one broken claim must not abort the sweep or the host nightly job.
    result.redispatchFailed += 1;
    console.error(`[placement-starter-recovery] re-dispatch failed for ${claim.id}`, err);
  }
}

async function sweepRetryScheduled(
  db: Db,
  claim: ClaimRow,
  now: Date,
  zombieCutoff: Date,
  result: PlacementStarterRecoveryResult,
): Promise<void> {
  if (claim.updated_at > zombieCutoff) {
    // Still inside the grace window — the owning pg-boss retry is expected to re-drive it. Park
    // the cursor exactly on the moment it becomes reapable (never backwards, never in the past).
    const reapableAt = new Date(
      claim.updated_at.getTime() + PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS,
    );
    const parked = new Date(Math.max(reapableAt.getTime(), now.getTime() + MIN_CURSOR_ADVANCE_MS));
    const bumped = await db
      .update(placement_starter_claim)
      .set({ next_reconcile_at: parked })
      .where(
        and(
          eq(placement_starter_claim.id, claim.id),
          eq(placement_starter_claim.status, 'retry_scheduled'),
          lte(placement_starter_claim.next_reconcile_at, now),
        ),
      )
      .returning({ id: placement_starter_claim.id });
    if (bumped.length === 1) result.retryPending += 1;
    else result.lost += 1;
    return;
  }

  // Zombie: no pg-boss redelivery is coming. Terminalize under a row lock and re-check, so a
  // delivery that acquires the attempt between the scan and this write wins instead of being
  // clobbered into a terminal state mid-flight.
  const reaped = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, claim.id))
      .for('update');
    if (!locked || locked.status !== 'retry_scheduled' || locked.updated_at > zombieCutoff) {
      return false;
    }
    await markPlacementStarterClaimTerminal(tx, claim.id, 'exhausted', now, {
      class: 'stalled',
      code: 'retry_never_redelivered',
      message:
        'placement starter claim sat in retry_scheduled past the redelivery grace window; no quiz_gen redelivery arrived',
    });
    return true;
  });
  if (reaped) result.reaped += 1;
  else result.lost += 1;
}
