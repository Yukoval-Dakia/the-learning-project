// YUK-544 — recurring merge-attribution sweep: census report + BOUNDED AUTO-REPAIR.
//
// applyMerge repairs all 9 attribution surfaces IN-TX at accept time, taking the per-KC advisory
// locks so a concurrent background-grading upsert of the merged-away id serializes against the merge.
// That narrows but cannot FULLY close one residual race (spec §3 row 5): a grading worker whose
// knowledgeIds arg was resolved from a stale pre-merge read can, AFTER the lock releases post-commit,
// write a fresh mastery/fsrs/axis/kc_typed row keyed to the now-archived from_id — because the grading
// path itself is out of the merge fix's blast radius.
//
// YUK-543 shipped this as a REPORT-ONLY census. YUK-544 promotes it to CENSUS + AUTO-REPAIR per the
// spec's own decision-4 (Appendix C, D-C): three first-party authorities (Google SRE ch.26, Shopify
// reconciliation, K8s controller doctrine) hold that report-only-forever is a documented UNFINISHED
// state, not a terminal one; and the repair is ALREADY idempotent + calls the SAME retire/rewrite
// functions as the live accept path, so closing the loop costs ≈0. Owner decision (a) picked auto-invoke.
//
// TWO PHASES per run:
//   1. CENSUS — resolveMergeChains → per resolved from_id, countOrphanSurfaces. Report the same counts
//      the report-only sweep logged (scanned / resolved / skipped / orphanSurfacesFound). Zero writes.
//   2. AUTO-REPAIR — for the DRIFTED subset (from_ids whose census surfaceTotal > 0), invoke the shared
//      repairMergeAttributionForFromId (NEVER raw table writes — single-writer guard) grouped by winner
//      in one tx per winner, bounded by a per-run hard cap. Each winner tx re-verifies the winner is
//      still live (TOCTOU vs a concurrent accept-merge) and is individually try/caught, so one failing
//      winner group rolls back alone and never starves the rest. Immediately after each winner tx
//      commits, a best-effort forensic event is written per repaired from_id; the repaired set is then
//      re-censused and asserted back to zero.
//
// STILL a safety-net, NOT a merge path: it only repairs the residual DRIFT the accept-time repair could
// not close, using the accept path's own repair mechanics. It never merges/archives a KC itself.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import {
  countOrphanSurfaces,
  groupResolvedChains,
  repairedSurfaceTotal,
  resolveMergeChains,
  surfaceTotal,
} from '../server/merge-attribution-backfill';
import { repairMergeAttributionForFromId } from '../server/proposals';

/**
 * WARN water level (repo guardrail convention: warning =告知-only, zero intervention). When the number
 * of DRIFTED from_ids detected in one run exceeds this, the sweep logs a loud warning but STILL repairs
 * (up to the hard cap) — a warning never blocks the self-heal. Normal steady state is 0 drifted from_ids
 * (the accept-time repair closes almost everything); a handful means the async-grading residual fired a
 * few times between weekly runs. Crossing WARN means something upstream changed (a merge storm, a
 * grading-path regression re-orphaning rows) and is worth an eyeball, not a page.
 */
const SWEEP_WARN_DRIFT_COUNT = 10;

/**
 * HARD CAP (repo guardrail convention: hard limit = 3-5× normal, only防事故). Max from_ids REPAIRED in
 * one run. Normal is 0-single-digit drifted; 50 is ≈5× the WARN level and a comfortable ceiling above
 * any plausible weekly residual. If a run somehow finds more than 50 drifted from_ids (a bulk
 * re-orphaning bug, or a first run after a long report-only gap), the sweep repairs the first 50 and
 * logs the leftover count as "deferred to next run" — the repair is idempotent so the leftover is picked
 * up on the following weekly run, converging without a single unbounded lock-holding transaction.
 */
const SWEEP_MAX_REPAIR_PER_RUN = 50;

export interface MergeAttributionSweepResult {
  /** distinct absorbed from_ids seen (appearing in some merged_from[]). */
  scannedFromIds: number;
  /** from_ids that resolved to a live terminal winner (repair-eligible). */
  resolved: number;
  /** from_ids skipped (archived-not-merged terminal or a merged_from cycle) — never guessed. */
  skipped: number;
  /** distinct terminal live winners across the resolved from_ids. */
  winners: number;
  /** total dangling surfaces the census found over ALL resolved from_ids (report parity with YUK-543). */
  orphanSurfacesFound: number;
  /** resolved from_ids whose census surfaceTotal > 0 (the drift set — repair candidates). */
  driftedFromIds: number;
  /** from_ids actually repaired this run (≤ hard cap). */
  repairedFromIds: number;
  /**
   * drifted from_ids left unrepaired this run — hard-cap overflow PLUS the from_ids of winner groups
   * whose winner turned out archived at repair time (a concurrent accept-merge absorbed it mid-run —
   * the liveness re-verify below). Both defer to the next run's idempotent continuation, where the
   * chain re-resolves through the newly archived winner to the new terminal.
   */
  deferredFromIds: number;
  /**
   * winner groups whose repair tx THREW and rolled back (per-winner isolation: logged, skipped, the
   * loop continues — one deterministically-failing winner can never starve the others). Next run
   * retries them idempotently.
   */
  failedWinners: number;
  /** sum of per-surface repairs performed this run (from each MergeRepairEntry). */
  surfacesRepaired: number;
  /** post-repair re-census over the repaired from_ids — MUST be 0 (idempotent repair). Non-zero → loud log, no throw. */
  residualAfterRepair: number;
  /** forensic `experimental:merge_attribution_repaired` events successfully written (best-effort). */
  eventsWritten: number;
}

export interface RunMergeAttributionSweepOpts {
  now?: Date;
  /** per-run repair cap; default SWEEP_MAX_REPAIR_PER_RUN. Injectable so tests can drive the cap cheaply. */
  maxRepair?: number;
  /** drift-warn water level; default SWEEP_WARN_DRIFT_COUNT. Injectable so tests can drive the WARN branch. */
  warnDrift?: number;
  /** sweep run identifier stamped on every repair event; default a fresh id. */
  runId?: string;
  /**
   * TEST-ONLY seam: awaited between the census/cap phase and the repair phase, so the TOCTOU test can
   * archive a winner in exactly the window the liveness re-verify defends (there is no way to inject
   * a concurrent accept-merge mid-run from outside otherwise). Mirrors the repo's injectable-seam
   * convention (kc_dedup_nightly's proposeFn, tag-knowledge's embedFn/nameKcFn). Never set in prod.
   */
  onBeforeRepairPhase?: () => Promise<void>;
}

/** Per-surface counts derived from a repair entry — the event payload's MergeRepairEntry summary. */
function summarizeRepair(entry: Awaited<ReturnType<typeof repairMergeAttributionForFromId>>) {
  return {
    questions: entry.question_ids_rewritten.length,
    learning_items: entry.learning_item_ids_rewritten.length,
    goals: entry.goal_ids_rewritten.length,
    edges: entry.edges_rewired.length,
    mastery_state: entry.mastery_state,
    fsrs_state: entry.fsrs_state,
    axis_state: entry.axis_state,
    kc_typed_state: entry.kc_typed_state,
    misconception_edges: entry.misconception_edges_rewritten.length,
  } as const;
}

/** Discriminated per-winner tx outcome: repaired entries, or "winner archived mid-run → defer". */
type WinnerTxOutcome =
  | {
      kind: 'ok';
      entries: { fromId: string; summary: ReturnType<typeof summarizeRepair>; surfaces: number }[];
    }
  | { kind: 'winner_archived' };

/**
 * Census the merge-attribution surfaces, then AUTO-REPAIR the drifted subset (bounded). Reuses the
 * shared primitives (resolveMergeChains / groupResolvedChains / countOrphanSurfaces / surfaceTotal /
 * repairedSurfaceTotal / repairMergeAttributionForFromId) so it can never diverge from the live accept
 * path or the one-time backfill.
 *
 * Failure containment: the REPAIR phase never throws. Each winner group runs in its own tx behind a
 * try/catch — a throwing winner (e.g. the ADR-0034 topology gate rejecting a rewritten prerequisite
 * edge, or a parse barrier on drifted jsonb) rolls back alone, is counted in `failedWinners`, and the
 * loop continues; forensic event writes are best-effort per from_id. Census-phase errors DO propagate
 * (nothing has been written yet) and reach pg-boss for DLQ retry.
 */
export async function runMergeAttributionSweep(
  db: Db,
  opts: RunMergeAttributionSweepOpts = {},
): Promise<MergeAttributionSweepResult> {
  const now = opts.now ?? new Date();
  const maxRepair = opts.maxRepair ?? SWEEP_MAX_REPAIR_PER_RUN;
  const warnDrift = opts.warnDrift ?? SWEEP_WARN_DRIFT_COUNT;
  const runId = opts.runId ?? newId();

  // ── Phase 1: census ──────────────────────────────────────────────────────────────────────────
  const resolutions = await resolveMergeChains(db);
  // Shared grouping (R3): winner → FULL absorbed set (the repair's `mergeFromIds` must be the
  // complete loser set for a winner even when we only repair a capped drifted subset, so
  // loser→loser edges collapse rather than dangle) + forensic chains + skip accounting.
  const {
    byWinner: allFromIdsByWinner,
    chainByFromId,
    resolvedFromIds,
    skipped,
  } = groupResolvedChains(resolutions, 'merge_attribution_sweep');

  // Census every resolved from_id; the drifted subset is those with a non-zero surface total.
  let orphanSurfacesFound = 0;
  const drifted: { fromId: string; winnerId: string }[] = [];
  for (const { fromId, winnerId } of resolvedFromIds) {
    const census = await countOrphanSurfaces(db, fromId);
    const total = surfaceTotal(census);
    orphanSurfacesFound += total;
    if (total > 0) drifted.push({ fromId, winnerId });
  }

  const baseResult: MergeAttributionSweepResult = {
    scannedFromIds: resolutions.length,
    resolved: resolvedFromIds.length,
    skipped,
    winners: allFromIdsByWinner.size,
    orphanSurfacesFound,
    driftedFromIds: drifted.length,
    repairedFromIds: 0,
    deferredFromIds: 0,
    failedWinners: 0,
    surfacesRepaired: 0,
    residualAfterRepair: 0,
    eventsWritten: 0,
  };

  if (drifted.length === 0) {
    console.log('[merge_attribution_sweep] clean — no dangling merge-attribution surfaces', {
      scannedFromIds: baseResult.scannedFromIds,
      resolved: baseResult.resolved,
      skipped: baseResult.skipped,
    });
    return baseResult;
  }

  // Guardrail — WARN water level (log-only, does not block the self-heal).
  if (drifted.length > warnDrift) {
    console.warn(
      `[merge_attribution_sweep] ELEVATED DRIFT — ${drifted.length} from_ids drifted (> WARN ${warnDrift}); repairing (capped at ${maxRepair})`,
      { driftedFromIds: drifted.length, warnDrift, runId },
    );
  }

  // Guardrail — HARD CAP. Repair the first `maxRepair` drifted from_ids; defer the rest to next run.
  const toRepair = drifted.slice(0, maxRepair);
  let deferredFromIds = drifted.length - toRepair.length;
  if (deferredFromIds > 0) {
    console.warn(
      `[merge_attribution_sweep] HARD CAP hit — repairing ${toRepair.length}/${drifted.length} drifted from_ids this run, ${deferredFromIds} deferred to next run (idempotent continuation)`,
      { cap: maxRepair, deferredFromIds, runId },
    );
  }

  // TEST-ONLY seam — see RunMergeAttributionSweepOpts.onBeforeRepairPhase.
  await opts.onBeforeRepairPhase?.();

  // ── Phase 2: bounded auto-repair (grouped by winner, one tx per winner) ────────────────────────
  const repairByWinner = new Map<string, string[]>();
  for (const d of toRepair) {
    const g = repairByWinner.get(d.winnerId);
    if (g) g.push(d.fromId);
    else repairByWinner.set(d.winnerId, [d.fromId]);
  }

  let failedWinners = 0;
  let eventsWritten = 0;
  const repaired: {
    fromId: string;
    winnerId: string;
    summary: ReturnType<typeof summarizeRepair>;
    surfaces: number;
  }[] = [];
  for (const [winnerId, fromIds] of repairByWinner) {
    // FULL absorbed set for this winner (not just the capped subset) so loser→loser edges collapse
    // identically to the accept path / one-time backfill.
    const mergeFromIds = new Set(allFromIdsByWinner.get(winnerId) ?? fromIds);
    let outcome: WinnerTxOutcome;
    try {
      outcome = await db.transaction(async (tx): Promise<WinnerTxOutcome> => {
        // TOCTOU re-verify — the census resolved winnerId WITHOUT any lock; a concurrent
        // accept-merge can archive this winner (absorbing it into a further node) in the window.
        // Of the 9 surface writers only createKnowledgeEdge self-protects (not_found on archived
        // endpoints); the other 8 would silently re-key rows onto an archived node. A locking read
        // (FOR UPDATE) is chosen over an advisory lock because it is the mechanism that OBSERVES a
        // committed concurrent archive: it blocks on applyMerge's in-flight row UPDATE (the archive
        // takes the row lock) and then re-reads the LATEST committed row version. Lock order matches
        // the accept path in the common case (knowledge row locks BEFORE per-KC advisory locks);
        // the narrow cross-order window (an accept holding advisory locks while appending
        // merged_from on OUR winner row) can deadlock, which Postgres detects and aborts one side —
        // the per-winner try/catch below degrades that to skip + next-run retry, never a stuck job.
        const winnerRow = await tx
          .select({ archived_at: knowledge.archived_at })
          .from(knowledge)
          .where(eq(knowledge.id, winnerId))
          .for('update');
        if (!winnerRow[0] || winnerRow[0].archived_at !== null) {
          return { kind: 'winner_archived' };
        }
        const entries: Extract<WinnerTxOutcome, { kind: 'ok' }>['entries'] = [];
        for (const fromId of fromIds) {
          const entry = await repairMergeAttributionForFromId(
            tx,
            fromId,
            winnerId,
            now,
            mergeFromIds,
          );
          // R1 — the SAME tally the backfill uses (repairedSurfaceTotal), never a local re-derivation.
          entries.push({
            fromId,
            summary: summarizeRepair(entry),
            surfaces: repairedSurfaceTotal(entry),
          });
        }
        return { kind: 'ok', entries };
      });
    } catch (err) {
      // Per-winner isolation — the throwing group rolled back alone; log loudly (with enough to
      // reproduce: winner, its capped from_ids, run id) and CONTINUE so Map-iteration-later winners
      // are never starved by one deterministically-failing group. Next run retries idempotently.
      failedWinners += 1;
      console.error(
        '[merge_attribution_sweep] winner repair FAILED — tx rolled back, skipping this winner (next run retries idempotently)',
        { winnerId, fromIds, runId },
        err,
      );
      continue;
    }

    if (outcome.kind === 'winner_archived') {
      deferredFromIds += fromIds.length;
      console.warn(
        '[merge_attribution_sweep] winner archived by a concurrent merge accept — deferring its from_ids; next run re-resolves the chain to the new terminal',
        { winnerId, fromIds, runId },
      );
      continue;
    }

    // Committed — log + write the forensic event PER from_id IMMEDIATELY (evidence-first: a later
    // winner's failure or a process crash must not cost the already-committed repairs their events;
    // the next census sees them clean and would never backfill the breadcrumb). Best-effort per
    // event: action `experimental:merge_attribution_repaired` is a GENERIC experimental event — NOT
    // in RESERVED_EXPERIMENTAL_ACTIONS, so parseEvent accepts it via the generic ExperimentalEvent
    // escape hatch, and it matches NO proposalWhere() / knowledge-fold / parity / recent_auto
    // predicate (verified YUK-544; same folds-fall-through shape as YUK-540's auto_tag_kc_matched).
    // subject_id is the repaired from_id (subject_kind 'knowledge'); the fold ignores it.
    for (const { fromId, summary, surfaces } of outcome.entries) {
      repaired.push({ fromId, winnerId, summary, surfaces });
      console.log('[merge_attribution_sweep] auto-repaired', {
        fromId,
        winnerId,
        chain: chainByFromId.get(fromId),
        surfaces,
        runId,
      });
      try {
        await writeEvent(db, {
          id: newId(),
          session_id: null,
          actor_kind: 'agent',
          actor_ref: 'merge_attribution_sweep',
          action: 'experimental:merge_attribution_repaired',
          subject_kind: 'knowledge',
          subject_id: fromId,
          outcome: 'success',
          payload: {
            source: 'merge_attribution_sweep',
            from_id: fromId,
            terminal_winner_id: winnerId,
            // No fallback: chainByFromId is built over ALL resolutions and repaired ⊆ resolutions,
            // so the lookup cannot miss (same unguarded call as the repair log above).
            chain: chainByFromId.get(fromId),
            repair_summary: summary,
            surfaces_repaired: surfaces,
            sweep_run_id: runId,
          },
          caused_by_event_id: null,
          task_run_id: null,
          cost_micro_usd: null,
        });
        eventsWritten += 1;
      } catch (err) {
        console.error(
          '[merge_attribution_sweep] repair audit event write failed (repair already committed)',
          fromId,
          err,
        );
      }
    }
  }

  const surfacesRepaired = repaired.reduce((n, r) => n + r.surfaces, 0);

  // Audit-gap watermark: repairs committed whose forensic event never landed are PERMANENT evidence
  // loss (the next census sees them clean and cannot backfill the breadcrumb) — say so loudly.
  if (eventsWritten < repaired.length) {
    console.warn(
      `[merge_attribution_sweep] AUDIT GAP — ${repaired.length - eventsWritten}/${repaired.length} forensic events failed to write (repairs committed; the gap will not self-heal)`,
      { eventsWritten, repairedFromIds: repaired.length, runId },
    );
  }

  // Zero-assertion — re-census the repaired from_ids; the idempotent repair must have driven them to 0.
  // Deliberately KEPT as a separate post-commit read (review E1): the repair's own counts come from
  // pre-UPDATE SELECTs inside the tx, so this re-census is the only read that can catch a stale
  // async-grading write racing in AFTER the repair committed — the exact residual this sweep exists
  // for. A non-zero residual is a loud signal, NOT a throw — report semantics hold, next run retries.
  let residualAfterRepair = 0;
  for (const { fromId } of repaired) {
    const census = await countOrphanSurfaces(db, fromId);
    residualAfterRepair += surfaceTotal(census);
  }
  if (residualAfterRepair > 0) {
    console.error(
      `[merge_attribution_sweep] POST-REPAIR RESIDUAL — ${residualAfterRepair} surfaces STILL dangling on ${repaired.length} repaired from_ids (expected 0); next run will retry`,
      { residualAfterRepair, repairedFromIds: repaired.length, runId },
    );
  } else {
    console.log(
      `[merge_attribution_sweep] auto-repair clean — ${repaired.length} from_ids repaired, ${surfacesRepaired} surfaces, post-repair census 0`,
      { repairedFromIds: repaired.length, surfacesRepaired, deferredFromIds, failedWinners, runId },
    );
  }

  return {
    ...baseResult,
    repairedFromIds: repaired.length,
    deferredFromIds,
    failedWinners,
    surfacesRepaired,
    residualAfterRepair,
    eventsWritten,
  };
}

/**
 * pg-boss handler builder. Runs the census + bounded auto-repair sweep and logs the outcome. A throw
 * here comes from the CENSUS phase (resolveMergeChains / countOrphanSurfaces — e.g. DB unreachable,
 * nothing written yet) and propagates to pg-boss for DLQ retry. Repair-phase failures never rethrow:
 * a throwing winner tx rolls back alone and is counted in `failedWinners` (per-winner isolation), a
 * failed forensic event write is logged + counted (best-effort) — the next weekly run re-censuses
 * and idempotently retries anything left.
 */
export function buildMergeAttributionSweepHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const r = await runMergeAttributionSweep(db);
      console.log('[merge_attribution_sweep] done', {
        scannedFromIds: r.scannedFromIds,
        driftedFromIds: r.driftedFromIds,
        repairedFromIds: r.repairedFromIds,
        deferredFromIds: r.deferredFromIds,
        failedWinners: r.failedWinners,
        surfacesRepaired: r.surfacesRepaired,
        residualAfterRepair: r.residualAfterRepair,
        eventsWritten: r.eventsWritten,
      });
    } catch (err) {
      console.error('[merge_attribution_sweep] failed', err);
      throw err;
    }
  };
}
