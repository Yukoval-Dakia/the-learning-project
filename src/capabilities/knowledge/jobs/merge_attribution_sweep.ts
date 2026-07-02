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
//      in one tx per winner, bounded by a per-run hard cap. Each repaired from_id gets a best-effort
//      forensic event; the repaired set is re-censused and asserted back to zero.
//
// STILL a safety-net, NOT a merge path: it only repairs the residual DRIFT the accept-time repair could
// not close, using the accept path's own repair mechanics. It never merges/archives a KC itself.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import type { Job } from 'pg-boss';
import {
  countOrphanSurfaces,
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
  /** drifted from_ids left unrepaired this run because the hard cap was hit (idempotent next-run continuation). */
  deferredFromIds: number;
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
  /** drift-warn water level; default SWEEP_WARN_DRIFT_COUNT. Injectable for tests. */
  warnDrift?: number;
  /** sweep run identifier stamped on every repair event; default a fresh id. */
  runId?: string;
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

/** Total surfaces a single repair touched (state fields count 1 when not 'noop'). */
function repairedSurfaceCount(s: ReturnType<typeof summarizeRepair>): number {
  return (
    s.questions +
    s.learning_items +
    s.goals +
    s.edges +
    (s.mastery_state !== 'noop' ? 1 : 0) +
    (s.fsrs_state !== 'noop' ? 1 : 0) +
    (s.axis_state !== 'noop' ? 1 : 0) +
    (s.kc_typed_state !== 'noop' ? 1 : 0) +
    s.misconception_edges
  );
}

/**
 * Census the merge-attribution surfaces, then AUTO-REPAIR the drifted subset (bounded). Reuses the
 * shared primitives (resolveMergeChains / countOrphanSurfaces / surfaceTotal / repairMergeAttributionForFromId)
 * so it can never diverge from the live accept path or the one-time backfill. Never throws on a repair
 * or event miss — report semantics are preserved (a failing run logs loudly, the next weekly run retries
 * idempotently). See the file header for the two-phase contract.
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
  // Full winner→[from_id] map over ALL resolved from_ids: the repair's `mergeFromIds` set must be the
  // COMPLETE absorbed set for a winner (so loser→loser edges collapse rather than dangle) even when we
  // only repair a capped drifted subset — mirrors runMergeAttributionBackfill's byWinner grouping.
  const allFromIdsByWinner = new Map<string, string[]>();
  const chainByFromId = new Map<string, string[]>();
  let skipped = 0;
  const resolvedFromIds: { fromId: string; winnerId: string }[] = [];
  for (const r of resolutions) {
    chainByFromId.set(r.fromId, r.chain);
    if (r.winnerId === null) {
      skipped += 1;
      console.warn('[merge_attribution_sweep] skipping unresolved chain', {
        fromId: r.fromId,
        reason: r.skipReason,
        chain: r.chain,
      });
      continue;
    }
    resolvedFromIds.push({ fromId: r.fromId, winnerId: r.winnerId });
    const group = allFromIdsByWinner.get(r.winnerId);
    if (group) group.push(r.fromId);
    else allFromIdsByWinner.set(r.winnerId, [r.fromId]);
  }

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
  const deferredFromIds = drifted.length - toRepair.length;
  if (deferredFromIds > 0) {
    console.warn(
      `[merge_attribution_sweep] HARD CAP hit — repairing ${toRepair.length}/${drifted.length} drifted from_ids this run, ${deferredFromIds} deferred to next run (idempotent continuation)`,
      { cap: maxRepair, deferredFromIds, runId },
    );
  }

  // ── Phase 2: bounded auto-repair (grouped by winner, one tx per winner) ────────────────────────
  const repairByWinner = new Map<string, string[]>();
  for (const d of toRepair) {
    const g = repairByWinner.get(d.winnerId);
    if (g) g.push(d.fromId);
    else repairByWinner.set(d.winnerId, [d.fromId]);
  }

  const repaired: {
    fromId: string;
    winnerId: string;
    summary: ReturnType<typeof summarizeRepair>;
  }[] = [];
  for (const [winnerId, fromIds] of repairByWinner) {
    // FULL absorbed set for this winner (not just the capped subset) so loser→loser edges collapse
    // identically to the accept path / one-time backfill.
    const mergeFromIds = new Set(allFromIdsByWinner.get(winnerId) ?? fromIds);
    const entries = await db.transaction(async (tx) => {
      const out: { fromId: string; summary: ReturnType<typeof summarizeRepair> }[] = [];
      for (const fromId of fromIds) {
        const entry = await repairMergeAttributionForFromId(
          tx,
          fromId,
          winnerId,
          now,
          mergeFromIds,
        );
        out.push({ fromId, summary: summarizeRepair(entry) });
      }
      return out;
    });
    for (const { fromId, summary } of entries) {
      repaired.push({ fromId, winnerId, summary });
      console.log('[merge_attribution_sweep] auto-repaired', {
        fromId,
        winnerId,
        chain: chainByFromId.get(fromId),
        surfaces: repairedSurfaceCount(summary),
        runId,
      });
    }
  }

  const surfacesRepaired = repaired.reduce((n, r) => n + repairedSurfaceCount(r.summary), 0);

  // Forensic event per repaired from_id — BEST-EFFORT (never poison the repair, which already committed
  // above). action `experimental:merge_attribution_repaired` is a GENERIC experimental event: it is NOT
  // in RESERVED_EXPERIMENTAL_ACTIONS, so parseEvent accepts it via the generic ExperimentalEvent escape
  // hatch, and it matches NO proposalWhere() / knowledge-fold / parity / recent_auto predicate (verified
  // YUK-544; same folds-fall-through shape as YUK-540's experimental:auto_tag_kc_matched). subject_id is
  // the repaired from_id (subject_kind 'knowledge'); the fold ignores it (no matching action branch).
  let eventsWritten = 0;
  for (const { fromId, winnerId, summary } of repaired) {
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
          chain: chainByFromId.get(fromId) ?? [fromId, winnerId],
          repair_summary: summary,
          surfaces_repaired: repairedSurfaceCount(summary),
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

  // Zero-assertion — re-census the repaired from_ids; the idempotent repair must have driven them to 0.
  // A non-zero residual is a loud signal (a repair helper missed a surface, or a new stale write raced in
  // mid-run), NOT a throw — report semantics hold, the next weekly run retries idempotently.
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
      { repairedFromIds: repaired.length, surfacesRepaired, deferredFromIds, runId },
    );
  }

  return {
    ...baseResult,
    repairedFromIds: repaired.length,
    deferredFromIds,
    surfacesRepaired,
    residualAfterRepair,
    eventsWritten,
  };
}

/**
 * pg-boss handler builder. Runs the census + bounded auto-repair sweep and logs the outcome. A throw
 * here is a genuine infra fault (DB down) → propagates to pg-boss for DLQ retry; per-repair / per-event
 * failures are already absorbed inside runMergeAttributionSweep (logged, never rethrown), so the next
 * weekly run re-censuses and idempotently retries any residual.
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
