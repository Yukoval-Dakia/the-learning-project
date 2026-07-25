// YUK-761 — placement starter claim recovery sweeper (「建成不通电」收口 for YUK-452 Phase B).
//
// YUK-452 Phase B shipped the recovery INFRASTRUCTURE — `placement_starter_claim.next_reconcile_at`
// (migration 0074) plus the partial `placement_starter_claim_recovery_idx` on
// (next_reconcile_at, created_at) WHERE status IN (5 nonterminal states) — and then explicitly
// left it without a consumer (placement-start.ts: "there is NO background sweeper for
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
//   So the sweeper terminalizes such a claim as 'exhausted' (the same terminal state
//   `finishPlacementAttempt` writes when the final delivery fails) — but ONLY after
//   `isPlacementStarterJobLive` confirms the owning quiz_gen job can no longer redeliver.
//   Elapsed time alone is NOT proof of death: a paused / saturated quiz_gen queue (or a downed
//   worker fleet) can hold a legitimate retry unfetched well past the grace window, and
//   terminalizing then would make the eventual delivery fail admission in
//   `acquirePlacementAttempt` and throw away paid generation work that was still coming.
//
// The other three nonterminal states inside the index predicate (queued / running / verifying)
// are NOT swept here: they are owned by a live pg-boss delivery and by the attempt lease/fence
// machinery. Widening the sweep to them needs its own lease-expiry analysis.
//
// ── Two INDEPENDENT legs, two independent budgets (anti-starvation) ───────────────────────
// The reap leg and the re-drive leg run their own capped queries. They must NOT share one scan:
// the re-drive leg is gated on PLACEMENT_PROBE_ENABLED and can accumulate a backlog of claims it
// declines to touch, and a single shared `ORDER BY next_reconcile_at LIMIT n` would let ≥n such
// rows monopolise every run forever — so a `retry_scheduled` zombie sorted behind them would
// NEVER be reaped, resurrecting the blocked-revision bug this sweeper exists to fix, via its own
// scan order. Separate queries make the reap leg structurally immune to whatever the paid leg
// does or skips.
//
// ── Idempotency / anti-double-drive ───────────────────────────────────────────────────────
// EVERY visited claim is ACQUIRED by a conditional UPDATE (`WHERE id = ? AND status = ? AND
// next_reconcile_at <= now` RETURNING) that pushes `next_reconcile_at` forward — including the
// paths that then decline to act (missing goal, still-live retry job) AND the paths that fail.
// A claim that is visited but never advanced would re-occupy the per-run budget on every
// subsequent run, which is the same starvation failure by another route. So the invariant is
// "visited ⇒ advanced", made total two ways: the re-drive leg acquires BEFORE its goal read and
// scope resolution (both of which do DB reads that can throw), and `guardClaim` advances the
// cursor best-effort on any escaping error. A second sweeper pass in the same window matches
// zero rows and does nothing.
//
// ── Failure containment (three nested rings) ──────────────────────────────────────────────
//   inner  — the individually risky calls (`dispatch`, the pg-boss liveness probe) are guarded
//            where they are made, so a normal failure keeps its specific counter and semantics.
//   claim  — `guardClaim` wraps a whole claim's handling: goal read, scope resolution, acquire,
//            reap transaction. One poisoned claim must never abort the rest of its leg.
//   leg    — `runLeg` wraps each scan + loop. Splitting the legs is pointless if one leg's scan
//            failure still takes the other down with it.
// The outermost ring lives at the CALL SITE, not here (see runQuestionSupplyNightly).
//
// The cursor bump deliberately does NOT touch `updated_at` or `version`: those mean "last STATE
// transition", and the retry_scheduled zombie reap reads `updated_at` as its staleness signal —
// bumping it on a scheduler visit would push the reap deadline out forever.

import type { Db } from '@/db/client';
import { goal, placement_starter_claim } from '@/db/schema';
import {
  PLACEMENT_PROBE_ENABLED,
  dispatchPlacementStarterClaim,
  isPlacementStarterJobLive,
  lockPlacementSupplyScopes,
  markPlacementStarterClaimTerminal,
  resolvePlacementStarterGoalAuthority,
} from '@/kernel/placement';
import { and, asc, eq, lte } from 'drizzle-orm';
import { resolveGoalPlacementScope } from './placement-scope';
import { selectNextPlacementItem } from './placement-select';

/**
 * How far forward the sweeper pushes `next_reconcile_at` when it acquires a claim. This is the
 * per-claim revisit cooldown and it is INDEPENDENT of the host job's cadence — a manual job run,
 * a second worker, or a duplicated orchestration run cannot re-drive the same claim inside this
 * window.
 */
export const PLACEMENT_STARTER_RECOVERY_BACKOFF_MS = 6 * 60 * 60_000;

/**
 * How long a claim must sit in `retry_scheduled` before it is CONSIDERED for reaping (the pg-boss
 * job-liveness probe still has the final say). Upper bound on a LEGITIMATE retry_scheduled window:
 * the pg-boss retry delay (30s→60s backoff) plus the time for the next delivery to acquire the
 * attempt and flip the claim to 'running' — seconds, not hours. Even a delivery that runs the full
 * AGENT `expireInSeconds` ceiling (2h) spends that time as 'running', not 'retry_scheduled'. 6h is
 * therefore a ~2 order-of-magnitude cushion; the liveness probe covers the remaining case where
 * the queue itself is stalled and elapsed time carries no information at all.
 */
export const PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS = 6 * 60 * 60_000;

/** Minimum forward movement of the cursor, so a visit always makes progress. */
const MIN_CURSOR_ADVANCE_MS = 60_000;

/**
 * Per-leg, per-run cap. Mirrors `question_supply_nightly`'s own DEFAULT_MAX_PER_RUN=25 — each
 * re-drive is a paid quiz_gen batch, so a first run against a large backlog must not flood the
 * paid queue. Applied to EACH leg separately (see the anti-starvation note above). Deferred
 * claims keep their overdue cursor and are picked up by the next run.
 */
const DEFAULT_MAX_PER_RUN = 25;

export interface PlacementStarterRecoveryResult {
  /** Overdue pending_dispatch claims returned by the re-drive leg's own scan (after its cap). */
  scannedPending: number;
  /** Overdue retry_scheduled claims returned by the reap leg's own scan (after its cap). */
  scannedRetry: number;
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
  /** retry_scheduled claims past grace whose quiz_gen job is STILL live — deliberately not reaped. */
  retryJobLive: number;
  /** Claims whose acquire CAS lost to a concurrent transition (already re-driven / terminalized elsewhere). */
  lost: number;
  /** Claims skipped because their goal row no longer exists (scope is unresolvable). */
  goalMissing: number;
  /** pending_dispatch claims cancelled because their semantic goal revision is no longer authoritative. */
  staleRevision: number;
  /** Claims whose handling threw outside the inner guards; cursor best-effort advanced, sweep continued. */
  claimErrors: number;
  /** Legs whose own scan query threw; the other leg still ran. */
  legErrors: number;
  /** True when PLACEMENT_PROBE_ENABLED is off: the paid re-drive leg did not run; the reap leg did. */
  redispatchSuppressed: boolean;
  /** True when the host caught a top-level sweep failure (see runQuestionSupplyNightly). */
  errored: boolean;
}

export interface PlacementStarterRecoveryDeps {
  now?: Date;
  maxPerRun?: number;
  /** Seam for DB tests: defaults to the real boss-backed dispatch. */
  dispatch?: typeof dispatchPlacementStarterClaim;
  /** Seam for DB tests: defaults to the real boss-backed pg-boss job-state probe. */
  isJobLive?: typeof isPlacementStarterJobLive;
  /** Seam for DB tests: defaults to the module-level dark-ship flag. */
  placementProbeEnabled?: boolean;
}

export function emptyPlacementStarterRecoveryResult(
  overrides: Partial<PlacementStarterRecoveryResult> = {},
): PlacementStarterRecoveryResult {
  return {
    scannedPending: 0,
    scannedRetry: 0,
    redispatched: 0,
    admissionSkipped: 0,
    redispatchFailed: 0,
    reaped: 0,
    retryPending: 0,
    retryJobLive: 0,
    lost: 0,
    goalMissing: 0,
    staleRevision: 0,
    claimErrors: 0,
    legErrors: 0,
    redispatchSuppressed: false,
    errored: false,
    ...overrides,
  };
}

type ClaimRow = typeof placement_starter_claim.$inferSelect;

/**
 * Advance a claim's recovery cursor. The conditional UPDATE is the acquire CAS: it both reserves
 * the claim against a concurrent sweeper AND guarantees the claim cannot re-occupy the next run's
 * budget. Never touches updated_at / version (see the module header).
 */
async function acquireClaim(
  db: Db,
  claim: ClaimRow,
  now: Date,
  nextReconcileAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(placement_starter_claim)
    .set({ next_reconcile_at: nextReconcileAt })
    .where(
      and(
        eq(placement_starter_claim.id, claim.id),
        eq(placement_starter_claim.status, claim.status),
        lte(placement_starter_claim.next_reconcile_at, now),
      ),
    )
    .returning({ id: placement_starter_claim.id });
  return rows.length === 1;
}

/** Run one leg, containing a failure of its own scan so the sibling leg still runs. */
async function runLeg(
  result: PlacementStarterRecoveryResult,
  leg: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    result.legErrors += 1;
    console.error(`[placement-starter-recovery] ${leg} leg failed; other legs unaffected`, err);
  }
}

/**
 * Run one claim's handling with total isolation. The inner handlers guard their own risky calls
 * (dispatch, pg-boss probe), but the surrounding steps — goal read, scope resolution, the acquire
 * itself, the reap transaction — can throw too, and an unguarded throw here would abort the rest
 * of the leg. On failure the cursor is advanced best-effort so the claim waits for the next window
 * instead of squatting a per-run slot forever (harmless if the handler already advanced it: the
 * CAS is conditional on `next_reconcile_at <= now` and simply matches nothing).
 */
async function guardClaim(
  db: Db,
  claim: ClaimRow,
  now: Date,
  result: PlacementStarterRecoveryResult,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    result.claimErrors += 1;
    console.error(`[placement-starter-recovery] claim ${claim.id} handling failed`, err);
    try {
      await acquireClaim(
        db,
        claim,
        now,
        new Date(now.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS),
      );
    } catch (advanceErr) {
      console.error(
        `[placement-starter-recovery] could not advance cursor for failed claim ${claim.id}`,
        advanceErr,
      );
    }
  }
}

/**
 * Overdue claims of exactly ONE status, oldest cursor first. The single-status equality plus the
 * range on next_reconcile_at keeps `placement_starter_claim_recovery_idx` usable (the status is
 * inside its partial predicate) and the ORDER BY is the index's own column order.
 */
function selectDueClaims(
  db: Db,
  status: 'pending_dispatch' | 'retry_scheduled',
  now: Date,
  limit: number,
) {
  return db
    .select()
    .from(placement_starter_claim)
    .where(
      and(
        eq(placement_starter_claim.status, status),
        lte(placement_starter_claim.next_reconcile_at, now),
      ),
    )
    .orderBy(
      asc(placement_starter_claim.next_reconcile_at),
      asc(placement_starter_claim.created_at),
    )
    .limit(limit);
}

/**
 * Sweep overdue placement starter claims: reap zombie `retry_scheduled` claims, re-drive stranded
 * `pending_dispatch` claims. Safe to call concurrently and safe to re-run — see the idempotency
 * note in the module header.
 */
export async function sweepStalePlacementStarterClaims(
  db: Db,
  deps: PlacementStarterRecoveryDeps = {},
): Promise<PlacementStarterRecoveryResult> {
  const now = deps.now ?? new Date();
  // Clamp: drizzle silently DROPS a non-positive `.limit()` rather than erroring, so a 0 /
  // negative override would turn the per-run cap into an unbounded scan — the exact opposite of
  // the cost guard it is there to be. Never trust the caller with the paid leg's ceiling.
  const maxPerRun = Math.max(1, Math.trunc(deps.maxPerRun ?? DEFAULT_MAX_PER_RUN));
  const dispatch = deps.dispatch ?? dispatchPlacementStarterClaim;
  const isJobLive = deps.isJobLive ?? isPlacementStarterJobLive;
  // G-COST: the re-drive leg makes PAID generation happen automatically. While the placement
  // entrypoint is dark there is no consumer for a freshly filled placement pool, so paying for
  // one would be pure waste. Reaping is free and unblocks later revisions, so it always runs —
  // and on its OWN query, so this gate can never starve it.
  const canRedispatch = deps.placementProbeEnabled ?? PLACEMENT_PROBE_ENABLED;
  const result = emptyPlacementStarterRecoveryResult({ redispatchSuppressed: !canRedispatch });

  const zombieCutoff = new Date(now.getTime() - PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS);

  // Each leg is isolated from the other: the whole point of splitting the scans is that the reap
  // leg cannot be held hostage by the paid leg, and that has to hold for FAILURE too, not just for
  // budget. A leg whose own scan query throws is counted and skipped; the other leg still runs.
  await runLeg(result, 'retry_scheduled', async () => {
    const dueRetry = await selectDueClaims(db, 'retry_scheduled', now, maxPerRun);
    result.scannedRetry = dueRetry.length;
    for (const claim of dueRetry) {
      await guardClaim(db, claim, now, result, () =>
        sweepRetryScheduled(db, claim, now, zombieCutoff, isJobLive, result),
      );
    }
  });

  if (canRedispatch) {
    await runLeg(result, 'pending_dispatch', async () => {
      const duePending = await selectDueClaims(db, 'pending_dispatch', now, maxPerRun);
      result.scannedPending = duePending.length;
      for (const claim of duePending) {
        await guardClaim(db, claim, now, result, () =>
          sweepPendingDispatch(db, claim, now, dispatch, result),
        );
      }
    });
  }

  // A background sweeper with no trace is undiagnosable. One summary line per run, ALWAYS — even
  // an all-zero run is the evidence that the tail step actually ran. The per-claim lines below
  // are reserved for consequential / anomalous outcomes and are bounded by maxPerRun per leg.
  console.log('[placement-starter-recovery] sweep', result);
  return result;
}

async function sweepPendingDispatch(
  db: Db,
  claim: ClaimRow,
  now: Date,
  dispatch: typeof dispatchPlacementStarterClaim,
  result: PlacementStarterRecoveryResult,
): Promise<void> {
  const backoffAt = new Date(now.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS);
  // ACQUIRE FIRST — before the goal read, before scope resolution, before any paid work. Both of
  // those do their own DB reads and can throw, and anything that runs BEFORE the acquire but
  // AFTER the claim has been picked up leaves the cursor un-advanced on failure, so the claim
  // re-occupies a per-run slot on every subsequent run: the starvation class again, entered
  // through the error path this time. Acquire-then-decide makes "visited ⇒ advanced" total.
  if (!(await acquireClaim(db, claim, now, backoffAt))) {
    result.lost += 1;
    return;
  }

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
    // Decline; the cursor is already advanced above.
    result.goalMissing += 1;
    console.warn(
      `[placement-starter-recovery] claim ${claim.id} references missing goal ${claim.goal_id}; skipped, cursor advanced`,
    );
    return;
  }
  // STALE-REVISION GUARD (review PRRT…ua3w). The live /placement/start path can only ever
  // dispatch the CURRENT revision's claim — it dispatches exactly the ids its own materialize just
  // produced. This sweeper is the only code that can pick up an OLD revision's claim, and doing so
  // is actively destructive: with two revisions stranded pending_dispatch (a pg-boss outage
  // spanning a goal edit), oldest-cursor-first dispatches the STALE one, it takes the
  // `placement_starter_claim_nonterminal_uq` slot for (goal, subject), and the CURRENT revision's
  // claim then loses the 23505 race and is terminalized 'cancelled' by
  // dispatchPlacementStarterClaimTx. Its id is deterministic in (revision, subject), so
  // re-materialize is an onConflictDoNothing no-op — the current revision can NEVER get a claim
  // again, and if the edit dropped the old revision's synthetic KC from scope, the generated batch
  // does not even serve the new session: permanent sourcingNeeded until the goal is edited again.
  //
  // So: never dispatch a claim whose revision is no longer authoritative. Terminalize it as
  // 'cancelled' with the same 'superseded' class dispatchPlacementStarterClaimTx uses — the
  // authority only moves forward, so a stale claim is undispatchable forever and must leave the
  // scan rather than be re-examined every window.
  const authority = await resolvePlacementStarterGoalAuthority(db, claim.goal_id);
  if (authority.semanticGoalRevisionId !== claim.semantic_goal_revision_id) {
    const cancelled = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: placement_starter_claim.status })
        .from(placement_starter_claim)
        .where(eq(placement_starter_claim.id, claim.id))
        .for('update');
      // Re-check under the row lock: a concurrent /placement/start may have dispatched this claim
      // between the scan and here, and a dispatched claim is not ours to cancel.
      if (locked?.status !== 'pending_dispatch') return false;
      await markPlacementStarterClaimTerminal(tx, claim.id, 'cancelled', now, {
        class: 'superseded',
        code: 'stale_revision',
        message: `placement starter claim is for superseded semantic goal revision ${claim.semantic_goal_revision_id}; current is ${authority.semanticGoalRevisionId}`,
      });
      return true;
    });
    if (cancelled) {
      result.staleRevision += 1;
      console.warn(
        `[placement-starter-recovery] cancelled stale-revision claim ${claim.id} (goal ${claim.goal_id}, revision ${claim.semantic_goal_revision_id} → current ${authority.semanticGoalRevisionId}); never dispatched`,
      );
    } else {
      result.lost += 1;
    }
    return;
  }

  const knowledgeIds = await resolveGoalPlacementScope(db, goalRow);

  try {
    // Same admission contract as /api/placement/start's cold path: serialize against pool
    // promotion for this KC scope, then pay ONLY if the scope still has no eligible item.
    const jobId = await dispatch(db, claim.id, async (tx) => {
      await lockPlacementSupplyScopes(tx, knowledgeIds);
      return (await selectNextPlacementItem(tx, { knowledgeIds })) === null;
    });
    if (jobId) {
      result.redispatched += 1;
      console.log(
        `[placement-starter-recovery] re-dispatched stranded claim ${claim.id} (goal ${claim.goal_id}, subject ${claim.subject_id}) as job ${jobId}`,
      );
    } else {
      result.admissionSkipped += 1;
    }
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
  isJobLive: typeof isPlacementStarterJobLive,
  result: PlacementStarterRecoveryResult,
): Promise<void> {
  if (claim.updated_at > zombieCutoff) {
    // Still inside the grace window — the owning pg-boss retry is expected to re-drive it. Park
    // the cursor exactly on the moment it becomes reapable (never backwards, never in the past).
    const reapableAt = new Date(
      claim.updated_at.getTime() + PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS,
    );
    const parked = new Date(Math.max(reapableAt.getTime(), now.getTime() + MIN_CURSOR_ADVANCE_MS));
    if (await acquireClaim(db, claim, now, parked)) result.retryPending += 1;
    else result.lost += 1;
    return;
  }

  // Past grace — but time is not proof of death. Ask pg-boss whether the owning job can still
  // redeliver. FAIL SAFE: any probe failure is treated as "still live", because a false reap
  // destroys in-flight paid work while a false skip merely defers the reap by one window.
  let jobLive: boolean;
  try {
    jobLive = await isJobLive(claim.pg_boss_job_id);
  } catch (err) {
    jobLive = true;
    console.error(
      `[placement-starter-recovery] pg-boss job probe failed for claim ${claim.id} (job ${claim.pg_boss_job_id}); treating as live, reap deferred`,
      err,
    );
  }
  if (jobLive) {
    const parked = new Date(now.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS);
    if (await acquireClaim(db, claim, now, parked)) result.retryJobLive += 1;
    else result.lost += 1;
    console.warn(
      `[placement-starter-recovery] claim ${claim.id} is past the retry grace window but its quiz_gen job ${claim.pg_boss_job_id} is still live; reap deferred`,
    );
    return;
  }

  // Zombie confirmed: past grace AND no redelivery source. Terminalize under a row lock and
  // re-check, so a delivery that acquires the attempt between the scan and this write wins
  // instead of being clobbered into a terminal state mid-flight.
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
        'placement starter claim sat in retry_scheduled past the redelivery grace window and its quiz_gen job can no longer redeliver',
    });
    return true;
  });
  if (reaped) {
    result.reaped += 1;
    console.warn(
      `[placement-starter-recovery] reaped zombie claim ${claim.id} (goal ${claim.goal_id}, subject ${claim.subject_id}, job ${claim.pg_boss_job_id}) as exhausted; it was blocking later revisions`,
    );
  } else {
    result.lost += 1;
  }
}
