// Weekly merge-attribution census plus bounded auto-repair.
//
// Accept-time merging already repairs attribution, but a grading worker holding a
// pre-merge read can still write to the archived id afterwards. This sweep repairs
// that residual drift with the same functions, never raw writes; it never merges or
// archives a KC. Census first, then repair drifted ids per winner, capped per run.
// Repairs are idempotent, so leftovers wait for the next run.

import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import {
  countOrphanSurfaces,
  groupResolvedChains,
  repairedSurfaceTotal,
  resolveMergeChains,
  surfaceTotal,
} from '../server/merge-attribution-backfill';
import { repairMergeAttributionForFromId } from '../server/proposals';

/** Elevated drift is worth a look, but never blocks the self-heal. */
const SWEEP_WARN_DRIFT_COUNT = 10;

/** Per-run repair cap; the remainder defers to the next idempotent run. */
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
  /** Dangling surfaces found over all resolved from_ids. */
  orphanSurfacesFound: number;
  /** Resolved from_ids with at least one dangling surface. */
  driftedFromIds: number;
  /** from_ids repaired this run (≤ hard cap). */
  repairedFromIds: number;
  /** Cap overflow plus winners archived mid-run; both defer to the next run. */
  deferredFromIds: number;
  /** Winner groups whose transaction threw and rolled back; retried next run. */
  failedWinners: number;
  surfacesRepaired: number;
  /** Post-repair re-census; must be zero. Non-zero logs loudly, does not throw. */
  residualAfterRepair: number;
  /** forensic `experimental:merge_attribution_repaired` events successfully written (best-effort). */
  eventsWritten: number;
}

export interface RunMergeAttributionSweepOpts {
  now?: Date;
  maxRepair?: number;
  warnDrift?: number;
  /** Stamped on every repair event; defaults to a fresh id. */
  runId?: string;
  /** Test-only seam between census and repair, to inject a concurrent archive. */
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
 * Census, then repair the drifted subset. Uses the same primitives as the accept path
 * and backfill so the three cannot diverge.
 *
 * Repair never throws: a failed winner rolls back alone and the loop continues, and
 * audit events are best effort. Census errors propagate because nothing was written.
 */
export async function runMergeAttributionSweep(
  db: Db,
  opts: RunMergeAttributionSweepOpts = {},
): Promise<MergeAttributionSweepResult> {
  const now = opts.now ?? new Date();
  const maxRepair = opts.maxRepair ?? SWEEP_MAX_REPAIR_PER_RUN;
  const warnDrift = opts.warnDrift ?? SWEEP_WARN_DRIFT_COUNT;
  const runId = opts.runId ?? newId();

  const resolutions = await resolveMergeChains(db);
  // The repair needs the full absorbed set per winner, not just the capped subset, or
  // loser-to-loser edges dangle instead of collapsing.
  const {
    byWinner: allFromIdsByWinner,
    chainByFromId,
    resolvedFromIds,
    skipped,
  } = groupResolvedChains(resolutions, 'merge_attribution_sweep');

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

  if (drifted.length > warnDrift) {
    console.warn(
      `[merge_attribution_sweep] ELEVATED DRIFT — ${drifted.length} from_ids drifted (> WARN ${warnDrift}); repairing (capped at ${maxRepair})`,
      { driftedFromIds: drifted.length, warnDrift, runId },
    );
  }

  const toRepair = drifted.slice(0, maxRepair);
  let deferredFromIds = drifted.length - toRepair.length;
  if (deferredFromIds > 0) {
    console.warn(
      `[merge_attribution_sweep] HARD CAP hit — repairing ${toRepair.length}/${drifted.length} drifted from_ids this run, ${deferredFromIds} deferred to next run (idempotent continuation)`,
      { cap: maxRepair, deferredFromIds, runId },
    );
  }

  await opts.onBeforeRepairPhase?.();

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
    let outcome: WinnerTxOutcome;
    try {
      // Fail loud rather than repair with the capped subset; that would leave
      // loser-to-loser edges dangling.
      const allFromIds = allFromIdsByWinner.get(winnerId);
      if (!allFromIds) {
        throw new Error(
          `winner ${winnerId} missing from the full absorbed-set map — refusing to repair with the capped subset (loser→loser edge collapse requires the FULL loser set)`,
        );
      }
      const mergeFromIds = new Set(allFromIds);
      outcome = await db.transaction(async (tx): Promise<WinnerTxOutcome> => {
        // Take the global write lock before the winner row, matching the accept path's
        // lock order so the two cannot deadlock.
        await acquireLearningStateWriteLock(tx);
        // Re-verify liveness under lock: the census resolved this winner unlocked, and
        // a concurrent accept may have archived it since. Only one of the nine surface
        // writers self-protects, so the rest would re-key rows onto an archived node.
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
          entries.push({
            fromId,
            summary: summarizeRepair(entry),
            surfaces: repairedSurfaceTotal(entry),
          });
        }
        return { kind: 'ok', entries };
      });
    } catch (err) {
      // Isolate the failure: this winner rolled back alone and later winners still run.
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

    // Write each event immediately after commit: a later crash must not lose the
    // breadcrumb once the next census sees the repair as clean. The action is a
    // generic experimental event, so no proposal/fold/dedup predicate claims it.
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
            chain: chainByFromId.get(fromId),
            repair_summary: summary,
            surfaces_repaired: surfaces,
            sweep_run_id: runId,
          },
          caused_by_event_id: null,
          task_run_id: null,
          cost_micro_usd: null,
          ingest_at: now,
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

  // A committed repair without its event is permanent evidence loss; say so loudly.
  if (eventsWritten < repaired.length) {
    console.warn(
      `[merge_attribution_sweep] AUDIT GAP — ${repaired.length - eventsWritten}/${repaired.length} forensic events failed to write (repairs committed; the gap will not self-heal)`,
      { eventsWritten, repairedFromIds: repaired.length, runId },
    );
  }

  // Re-census after commit: the only read that can catch a grading write racing in
  // after the repair, which is the residual this sweep exists for.
  let residualAfterRepair = 0;
  try {
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
        {
          repairedFromIds: repaired.length,
          surfacesRepaired,
          deferredFromIds,
          failedWinners,
          runId,
        },
      );
    }
  } catch (err) {
    // Repairs are already committed, so a read failure must not retry finished work.
    console.error(
      '[merge_attribution_sweep] POST-REPAIR RE-CENSUS FAILED — repairs committed; verification unavailable this run; next weekly run re-censuses',
      { repairedFromIds: repaired.length, runId },
      err,
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

/** Handler. Only census errors reach pg-boss; repair failures are isolated above. */
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
