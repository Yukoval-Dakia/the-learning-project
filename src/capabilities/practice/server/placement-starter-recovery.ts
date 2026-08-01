// YUK-761 / YUK-776 — placement starter claim recovery sweeper.
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
// `queued` / `running` / `verifying` — FAIL-CLOSED REAP. A valid in-flight attempt owns its claim
//   while `lease_expires_at > now`; elapsed claim `updated_at` is not delivery authority (attempt
//   heartbeats renew the lease independently). Once no active lease remains, the owning job is the final
//   redelivery authority. Only when that job is also confirmed non-live may recovery atomically
//   fence an expired attempt (`interrupted`), supersede its authorized questions, and terminalize
//   the claim as `exhausted`. A renewed/rotated fence or a live/unreadable job always wins and is
//   deferred. queued legitimately has no attempt, so its proof is "no active attempt + dead job".
//
// ── Three INDEPENDENT legs, three independent budgets (anti-starvation) ───────────────────
// The two reap legs and the re-drive leg run their own capped queries. They must NOT share one scan:
// the re-drive leg is gated on PLACEMENT_PROBE_ENABLED and can accumulate a backlog of claims it
// declines to touch, and a single shared `ORDER BY next_reconcile_at LIMIT n` would let ≥n such
// rows monopolise every run forever — so a `retry_scheduled` zombie sorted behind them would
// NEVER be reaped, resurrecting the blocked-revision bug this sweeper exists to fix, via its own
// scan order. Separate queries make both reap classes structurally immune to whatever the paid
// leg does or skips.
//
// ── Idempotency / anti-double-drive ───────────────────────────────────────────────────────
// EVERY visited claim is ACQUIRED by a conditional UPDATE (`WHERE id = ? AND status = ? AND
// next_reconcile_at <= now` RETURNING) that pushes `next_reconcile_at` forward — including the
// paths that then decline to act (missing goal, still-live retry job) AND the paths that fail.
// A claim that is visited but never advanced would re-occupy the per-run budget on every
// subsequent run, which is the same starvation failure by another route. So the invariant is
// "visited ⇒ advanced", and it admits NO exceptions: ALL legs acquire before doing anything that
// can fail or that reaches outside this process — the re-drive leg before its goal read, authority
// pre-check and scope resolution (all DB reads that can throw), and both reap legs before their
// pg-boss liveness probe (which also means never querying pg-boss on behalf of a claim another
// sweeper already owns). `guardClaim` then advances the cursor best-effort on anything that escapes.
// A second sweeper pass in the same window matches zero rows and does nothing.
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
import { goal, placement_starter_attempt, placement_starter_claim } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  PLACEMENT_PROBE_ENABLED,
  PLACEMENT_QUEUE_EXPIRY_MS,
  dispatchPlacementStarterClaim,
  isPlacementStarterJobLive,
  lockPlacementSupplyScopes,
  markPlacementStarterClaimTerminal,
  resolvePlacementStarterGoalAuthority,
  terminalizeLostPlacementDelivery,
} from '@/kernel/placement';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
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
  /** Overdue queued/running/verifying claims returned by the lease/fence leg's own scan. */
  scannedInflight: number;
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
  /** In-flight claims terminalized after both lease/fence and job-liveness authority were gone. */
  inflightReaped: number;
  /** queued claims still inside the pg-boss queue expiry window. */
  inflightQueuePending: number;
  /** In-flight claims deferred because an attempt still held an unexpired lease. */
  inflightLeaseActive: number;
  /** Lease-expired/attempt-less in-flight claims deferred because the owning job remained live. */
  inflightJobLive: number;
  /** Claims whose acquire CAS lost to a concurrent transition (already re-driven / terminalized elsewhere). */
  lost: number;
  /** Claims skipped because their goal row no longer exists (scope is unresolvable). */
  goalMissing: number;
  /** pending_dispatch claims cancelled because their semantic goal revision is no longer authoritative. */
  staleRevision: number;
  /** pending_dispatch claims deferred (never cancelled) because their goal is dormant / done. */
  goalNotActive: number;
  /** Claims a concurrent /placement/start (or another sweeper) dispatched first; this sweeper stood down. */
  dispatchedElsewhere: number;
  /** Claims deferred because the goal row was locked by a concurrent writer (NOWAIT, never blocks). */
  goalLockBusy: number;
  /** Claims whose handling threw outside the inner guards; cursor best-effort advanced, sweep continued. */
  claimErrors: number;
  /** Legs whose own scan query threw; sibling legs still ran. */
  legErrors: number;
  /** True when PLACEMENT_PROBE_ENABLED is off: the paid re-drive leg did not run; reap legs did. */
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
    scannedInflight: 0,
    redispatched: 0,
    admissionSkipped: 0,
    redispatchFailed: 0,
    reaped: 0,
    retryPending: 0,
    retryJobLive: 0,
    inflightReaped: 0,
    inflightQueuePending: 0,
    inflightLeaseActive: 0,
    inflightJobLive: 0,
    lost: 0,
    goalMissing: 0,
    staleRevision: 0,
    goalNotActive: 0,
    dispatchedElsewhere: 0,
    goalLockBusy: 0,
    claimErrors: 0,
    legErrors: 0,
    redispatchSuppressed: false,
    errored: false,
    ...overrides,
  };
}

type ClaimRow = typeof placement_starter_claim.$inferSelect;

/**
 * Postgres `lock_not_available` (55P03) — what `FOR UPDATE ... NOWAIT` raises when the row is
 * already locked. drizzle wraps driver errors, so walk the `.cause` chain (same shape as
 * `isNonterminalSingleFlightViolation` in @/server/question-supply/placement-starter).
 */
function isGoalLockUnavailable(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 5; depth++) {
    const e = cur as { code?: string; cause?: unknown };
    if (e.code === '55P03') return true;
    cur = e.cause;
  }
  return false;
}

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

/** Refine the cursor after an acquire without reopening it to another sweeper. */
async function rescheduleAcquiredClaim(
  db: Db,
  claim: ClaimRow,
  acquiredUntil: Date,
  nextReconcileAt: Date,
): Promise<void> {
  await db
    .update(placement_starter_claim)
    .set({ next_reconcile_at: nextReconcileAt })
    .where(
      and(
        eq(placement_starter_claim.id, claim.id),
        eq(placement_starter_claim.status, claim.status),
        eq(placement_starter_claim.next_reconcile_at, acquiredUntil),
      ),
    );
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
 * Terminalize a claim whose semantic goal revision is no longer authoritative. The authority only
 * moves forward, so a stale claim is undispatchable forever and must leave the scan rather than be
 * re-examined every window. This explicit authority proof is deliberately different from a bare
 * single-flight 23505, which cannot tell whether its loser is stale or current. Locks the claim row and
 * re-checks `pending_dispatch` first: a concurrent /placement/start may have dispatched it between
 * the scan and here, and a dispatched claim is not ours to cancel.
 */
async function cancelSupersededClaim(
  db: Db,
  claim: ClaimRow,
  now: Date,
  currentRevisionId: string,
  result: PlacementStarterRecoveryResult,
): Promise<void> {
  const cancelled = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: placement_starter_claim.status })
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, claim.id))
      .for('update');
    if (locked?.status !== 'pending_dispatch') return false;
    await markPlacementStarterClaimTerminal(tx, claim.id, 'cancelled', now, {
      class: 'superseded',
      code: 'stale_revision',
      message: `placement starter claim is for superseded semantic goal revision ${claim.semantic_goal_revision_id}; current is ${currentRevisionId}`,
    });
    return true;
  });
  if (cancelled) {
    result.staleRevision += 1;
    console.warn(
      `[placement-starter-recovery] cancelled stale-revision claim ${claim.id} (goal ${claim.goal_id}, revision ${claim.semantic_goal_revision_id} → current ${currentRevisionId}); never dispatched`,
    );
  } else {
    result.lost += 1;
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
 * queued/running/verifying use one independent claim-side cursor budget. The attempt lookup stays
 * inside the handler so queued (which normally has no attempt) remains a first-class state rather
 * than disappearing through an inner join.
 */
function selectDueInflightClaims(db: Db, now: Date, limit: number) {
  return db
    .select()
    .from(placement_starter_claim)
    .where(
      and(
        inArray(placement_starter_claim.status, ['queued', 'running', 'verifying']),
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
 * Sweep overdue placement starter claims: reap zombie retries and lost in-flight deliveries, then
 * re-drive stranded pending claims. Safe to call concurrently and safe to re-run — see the
 * idempotency note in the module header.
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

  // Each leg is isolated from its siblings: neither reap class can be held hostage by the paid
  // leg (or by each other), and that has to hold for FAILURE too, not just for budget.
  await runLeg(result, 'retry_scheduled', async () => {
    const dueRetry = await selectDueClaims(db, 'retry_scheduled', now, maxPerRun);
    result.scannedRetry = dueRetry.length;
    for (const claim of dueRetry) {
      await guardClaim(db, claim, now, result, () =>
        sweepRetryScheduled(db, claim, now, zombieCutoff, isJobLive, result),
      );
    }
  });

  // MUST precede pending_dispatch. A current-revision pending claim can coexist with an older
  // in-flight claim for the same goal+subject because pending is outside nonterminal_uq. Reaping a
  // provably dead old delivery first lets the current claim dispatch in this same sweep. When the
  // old job is still live, the later paid leg safely loses the unique race and leaves current
  // pending for a future window rather than cancelling it (YUK-776).
  await runLeg(result, 'queued_running_verifying', async () => {
    const dueInflight = await selectDueInflightClaims(db, now, maxPerRun);
    result.scannedInflight = dueInflight.length;
    for (const claim of dueInflight) {
      await guardClaim(db, claim, now, result, () =>
        sweepInflightClaim(db, claim, now, isJobLive, result),
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

async function sweepInflightClaim(
  db: Db,
  claim: ClaimRow,
  now: Date,
  isJobLive: typeof isPlacementStarterJobLive,
  result: PlacementStarterRecoveryResult,
): Promise<void> {
  // queued has no attempt lease in the normal state. Its existing 120-minute pg-boss queue expiry
  // is the earliest point at which recovery may treat a missing/dead job as lost; before then we
  // park exactly on that deadline and do not even probe the external queue.
  if (claim.status === 'queued') {
    const expiresAt = new Date(claim.updated_at.getTime() + PLACEMENT_QUEUE_EXPIRY_MS);
    if (expiresAt > now) {
      const parked = new Date(Math.max(expiresAt.getTime(), now.getTime() + MIN_CURSOR_ADVANCE_MS));
      if (await acquireClaim(db, claim, now, parked)) result.inflightQueuePending += 1;
      else result.lost += 1;
      return;
    }
  }

  // Reserve the claim before any attempt read or pg-boss call. This is the same visited⇒advanced
  // rule as the existing legs and guarantees two sweepers never probe/reap on one cursor window.
  const backoffAt = new Date(now.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS);
  if (!(await acquireClaim(db, claim, now, backoffAt))) {
    result.lost += 1;
    return;
  }

  const [attempt] = await db
    .select({
      attemptId: placement_starter_attempt.id,
      fencingToken: placement_starter_attempt.fencing_token,
      pgBossJobId: placement_starter_attempt.pg_boss_job_id,
      leaseExpiresAt: placement_starter_attempt.lease_expires_at,
    })
    .from(placement_starter_attempt)
    .where(
      and(
        eq(placement_starter_attempt.claim_id, claim.id),
        inArray(placement_starter_attempt.status, ['running', 'verifying']),
      ),
    )
    .limit(1);

  if (attempt?.leaseExpiresAt && attempt.leaseExpiresAt > now) {
    await rescheduleAcquiredClaim(
      db,
      claim,
      backoffAt,
      new Date(Math.max(attempt.leaseExpiresAt.getTime(), now.getTime() + MIN_CURSOR_ADVANCE_MS)),
    );
    result.inflightLeaseActive += 1;
    return;
  }
  // A mismatched active attempt is an integrity anomaly, not authority to destroy. Do not probe
  // only one of two jobs and guess; defer fail-closed for inspection.
  if (attempt && attempt.pgBossJobId !== claim.pg_boss_job_id) {
    result.lost += 1;
    console.error(
      `[placement-starter-recovery] claim ${claim.id} job ${claim.pg_boss_job_id} disagrees with active attempt ${attempt.attemptId} job ${attempt.pgBossJobId}; deferred`,
    );
    return;
  }

  let jobLive: boolean;
  try {
    jobLive = await isJobLive(claim.pg_boss_job_id);
  } catch (err) {
    jobLive = true;
    console.error(
      `[placement-starter-recovery] pg-boss job probe failed for in-flight claim ${claim.id} (job ${claim.pg_boss_job_id}); treating as live`,
      err,
    );
  }
  if (jobLive) {
    result.inflightJobLive += 1;
    return;
  }

  const reaped = await terminalizeLostPlacementDelivery(
    db,
    {
      claimId: claim.id,
      pgBossJobId: claim.pg_boss_job_id,
      attempt: attempt
        ? {
            attemptId: attempt.attemptId,
            fencingToken: attempt.fencingToken,
            pgBossJobId: attempt.pgBossJobId,
          }
        : null,
    },
    now,
  );
  if (reaped) {
    result.inflightReaped += 1;
    console.warn(
      `[placement-starter-recovery] reaped lost in-flight claim ${claim.id} (status ${claim.status}, job ${claim.pg_boss_job_id}) as exhausted; later revisions are unblocked`,
    );
  } else {
    result.lost += 1;
  }
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
      status: goal.status,
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
  // NON-ACTIVE GOAL GUARD (review PRRT…upw3). A goal retracted to 'dormant' (the proposal retract
  // path, src/server/proposals/actions.ts) or finished as 'done' has left the active-goal flow, but
  // its stranded claim is untouched: `resolvePlacementStarterGoalAuthority` derives the revision
  // from genesis/scope events only, so a STATUS change does not invalidate it and the revision
  // guard below sails straight through. Without this check the sweeper would automatically spend
  // real money generating a placement batch for a goal the owner has retired — and again, only the
  // sweeper can: /placement/start runs on an explicit learner action against that goal.
  //
  // DEFER, never cancel. 'dormant' is reversible, and cancelling would be permanent: claim ids are
  // deterministic in (revision, subject) and materialize is `onConflictDoNothing`, so a cancelled
  // claim can never be re-created — reactivating the goal would leave placement stuck on
  // sourcingNeeded forever (the same trap the stale-revision guard exists to avoid, entered from
  // the other side). Deferring costs one cheap query per window and makes reactivation just work:
  // the next sweep sees 'active' again and dispatches.
  if (goalRow.status !== 'active') {
    result.goalNotActive += 1;
    console.warn(
      `[placement-starter-recovery] claim ${claim.id} belongs to ${goalRow.status} goal ${claim.goal_id}; deferred (not cancelled), cursor advanced`,
    );
    return;
  }
  // STALE-REVISION GUARD (review PRRT…ua3w). The live /placement/start path can only ever
  // dispatch the CURRENT revision's claim — it dispatches exactly the ids its own materialize just
  // produced. This sweeper is the only code that can pick up an OLD revision's claim, and doing so
  // is actively destructive: with two revisions stranded pending_dispatch (a pg-boss outage
  // spanning a goal edit), oldest-cursor-first could pay to dispatch the STALE one and let it hold
  // the `placement_starter_claim_nonterminal_uq` slot for (goal, subject). The CURRENT claim now
  // stays pending on that conflict (YUK-776), but the paid stale batch may not serve the edited
  // goal at all and unnecessarily delays the authoritative work.
  //
  // So: never dispatch a claim whose revision is no longer authoritative. Terminalize it as
  // 'cancelled' with an explicit 'superseded' reason — unlike a single-flight collision, the
  // authority check proves this claim can never become dispatchable. The check happens TWICE: this first one is an
  // unlocked pre-check — cheap, and it short-circuits the overwhelmingly common case (a revision
  // superseded long ago) without opening a dispatch transaction at all. It is NOT sufficient on
  // its own: see the authoritative re-check inside the dispatch tx below.
  let authority: Awaited<ReturnType<typeof resolvePlacementStarterGoalAuthority>>;
  try {
    authority = await resolvePlacementStarterGoalAuthority(db, claim.goal_id);
  } catch (err) {
    // The goal existence check above is a separate statement, so under READ COMMITTED the row can
    // disappear in between and this resolver 404s. Vanishingly unlikely today (goals are
    // status-retracted, not hard-deleted) and harmless either way — the cursor is already
    // advanced — but letting it reach guardClaim would label a routine race as `claimErrors` and
    // send whoever reads the summary looking for a bug that is not there.
    if (err instanceof ApiError && err.code === 'not_found') {
      result.goalMissing += 1;
      console.warn(
        `[placement-starter-recovery] goal ${claim.goal_id} vanished between checks; claim ${claim.id} skipped, cursor advanced`,
      );
      return;
    }
    throw err;
  }
  if (authority.semanticGoalRevisionId !== claim.semantic_goal_revision_id) {
    await cancelSupersededClaim(db, claim, now, authority.semanticGoalRevisionId, result);
    return;
  }

  const knowledgeIds = await resolveGoalPlacementScope(db, goalRow);

  try {
    let supersededRevisionId: string | null = null;
    let notActiveStatus: string | null = null;
    let goalLockBusy = false;
    // Whether OUR admission callback ran at all. `dispatchPlacementStarterClaimTx` re-reads the
    // claim FOR UPDATE and early-returns `claim.pg_boss_job_id` when the status is no longer
    // 'pending_dispatch' — WITHOUT calling admit. So a non-null return does not by itself mean we
    // dispatched: a /placement/start that landed between our acquire (which moves only the cursor,
    // never the status) and our dispatch call would have dispatched it, and we would be handed
    // that job's id. Without this flag the sweeper credits itself for someone else's dispatch and
    // logs "re-dispatched" for a claim it never drove (review PRRT…0VF).
    let admitInvoked = false;
    // Same admission contract as /api/placement/start's cold path: serialize against pool
    // promotion for this KC scope, then pay ONLY if the scope still has no eligible item.
    const jobId = await dispatch(db, claim.id, async (tx) => {
      admitInvoked = true;
      // AUTHORITATIVE RE-CHECK of BOTH goal preconditions (review PRRT…h8a, PRRT…upw3). The two
      // checks above are lockless reads, so a goal re-scoped OR retracted between them and the
      // dispatch transaction taking the claim row lock would still get a paid batch dispatched —
      // and for the revision case that is the destructive outcome in full, not a near-miss. Redo
      // both HERE, inside the dispatch tx, holding the goal row locked so a concurrent scope or
      // status update must serialize against us.
      //
      // ── Why NOWAIT (review PRRT…HNf) ────────────────────────────────────────────────────
      // This path locks claim → goal, while materializePlacementStartersForGoal locks goal →
      // claim (goal FOR UPDATE, then INSERT ... ON CONFLICT DO NOTHING on the claim, which waits
      // on a claim row this sweeper holds). A plain FOR UPDATE here is therefore a genuine AB-BA
      // cycle whenever a /placement/start hits the SAME goal during the sweep window, and the
      // earlier revision of this comment merely documented that — including that Postgres might
      // abort the LEARNER's transaction, i.e. a 5xx for a real person, which is not a cost a
      // background hygiene job gets to impose.
      //
      // NOWAIT removes the cycle instead of describing it: a deadlock requires both sides to
      // WAIT, and this side now never waits. If the goal row is already locked — which in practice
      // means a /placement/start is mid-materialize for this very goal — we fail instantly with
      // 55P03, roll back to the savepoint, and defer the claim to the next window. That is the
      // right answer on the merits too: the learner's own dispatch is happening right now, so the
      // sweeper has nothing to add. The learner never waits on us beyond our own short dispatch
      // tx, and never deadlocks with us. The serialization guarantee is unchanged in the common
      // case, where the lock is free and we take it.
      //
      // The attempt is wrapped in a SAVEPOINT because a failed statement poisons the enclosing
      // transaction; rolling back to the savepoint leaves the dispatch tx usable so we can return
      // a clean "declined" rather than aborting it.
      let goalRowStatus: string | null = null;
      try {
        await tx.transaction(async (sp) => {
          const [row] = await sp
            .select({ status: goal.status })
            .from(goal)
            .where(eq(goal.id, claim.goal_id))
            .for('update', { noWait: true });
          goalRowStatus = row?.status ?? 'missing';
        });
      } catch (err) {
        if (!isGoalLockUnavailable(err)) throw err;
        goalLockBusy = true;
        return false; // decline; cursor already advanced, retried next window
      }
      // `goalRowStatus` is assigned on every path that reaches here — the try block always sets it
      // and the catch either re-throws or returns. TypeScript cannot narrow across the closure, so
      // the `??` is purely a type-level sentinel; it also keeps `notActiveStatus` non-null, which
      // the dispatch-site branch below relies on.
      if (goalRowStatus !== 'active') {
        notActiveStatus = goalRowStatus ?? 'missing';
        return false; // suppress dispatch; deferred (NOT cancelled — see the pre-check rationale)
      }
      const authorityNow = await resolvePlacementStarterGoalAuthority(tx, claim.goal_id);
      if (authorityNow.semanticGoalRevisionId !== claim.semantic_goal_revision_id) {
        supersededRevisionId = authorityNow.semanticGoalRevisionId;
        return false; // suppress dispatch; the claim is terminalized below, outside this tx
      }
      await lockPlacementSupplyScopes(tx, knowledgeIds);
      return (await selectNextPlacementItem(tx, { knowledgeIds })) === null;
    });
    if (!admitInvoked) {
      // Early return inside dispatchPlacementStarterClaimTx: the claim was no longer
      // 'pending_dispatch' when it took the row lock. Someone else — a concurrent
      // /placement/start, or another sweeper — owns this dispatch. Counted separately so
      // `redispatched` stays an honest count of what THIS sweeper actually drove.
      result.dispatchedElsewhere += 1;
      console.log(
        jobId
          ? `[placement-starter-recovery] claim ${claim.id} was already dispatched concurrently as job ${jobId}; sweeper stood down`
          : `[placement-starter-recovery] claim ${claim.id} left pending_dispatch concurrently before the sweeper could drive it; stood down`,
      );
    } else if (goalLockBusy) {
      // The goal row was locked by a concurrent writer — in practice a /placement/start
      // mid-materialize for this very goal, which is dispatching the claim itself. Standing down
      // is both deadlock-free and correct on the merits; the cursor is already advanced.
      result.goalLockBusy += 1;
      console.log(
        `[placement-starter-recovery] goal ${claim.goal_id} is locked by a concurrent writer; claim ${claim.id} deferred to the next window`,
      );
    } else if (notActiveStatus !== null) {
      // Goal left the active flow between the pre-check and admission. Nothing was enqueued; the
      // claim keeps its advanced cursor and is retried once the goal is active again.
      result.goalNotActive += 1;
      console.warn(
        `[placement-starter-recovery] claim ${claim.id} goal ${claim.goal_id} became ${notActiveStatus} before dispatch; deferred`,
      );
    } else if (supersededRevisionId !== null) {
      // Admission refused for staleness, so nothing was enqueued and the claim is still
      // pending_dispatch. Terminalize it in its own transaction (same shape as the pre-check path).
      await cancelSupersededClaim(db, claim, now, supersededRevisionId, result);
    } else if (jobId) {
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

  // Past grace. ACQUIRE FIRST, before the pg-boss probe — the "visited ⇒ advanced" invariant in
  // the module header admits no exceptions, and an external query issued before winning the CAS
  // would also mean probing pg-boss on behalf of a claim another sweeper already owns. The parked
  // cursor is the standard backoff, which is exactly right for the "still live → defer" outcome
  // below and irrelevant when we go on to terminalize (the row leaves the scan entirely).
  if (
    !(await acquireClaim(
      db,
      claim,
      now,
      new Date(now.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS),
    ))
  ) {
    result.lost += 1;
    return;
  }

  // Time is not proof of death. Ask pg-boss whether the owning job can still redeliver. FAIL SAFE:
  // any probe failure is treated as "still live", because a false reap destroys in-flight paid work
  // while a false skip merely defers the reap by one window.
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
    result.retryJobLive += 1;
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
