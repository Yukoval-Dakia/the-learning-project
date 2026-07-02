// YUK-543 — report-only merge-attribution sweep (recurring safety net).
//
// applyMerge repairs all 9 attribution surfaces IN-TX at accept time, taking the per-KC advisory
// locks so a concurrent background-grading upsert of the merged-away id serializes against the merge.
// That narrows but cannot FULLY close one residual race (spec §3 row 5): a grading worker whose
// knowledgeIds arg was resolved from a stale pre-merge read can, AFTER the lock releases post-commit,
// write a fresh mastery/fsrs row keyed to the now-archived from_id — because the grading path itself
// is out of this fix's blast radius. This low-frequency sweep DETECTS any such residual orphan and
// logs it for the owner. It is REPORT-ONLY (dryRun) — it writes NOTHING, never merges/repairs on its
// own (repair is the human-gated backfill's job). Same predicate as scripts/backfill-merge-attribution.ts.

import type { Db } from '@/db/client';
import type { Job } from 'pg-boss';
import { runMergeAttributionBackfill } from '../server/merge-attribution-backfill';

/**
 * pg-boss handler builder (mirrors buildKcDedupNightlyHandler). Runs the merge-attribution census in
 * READ-ONLY mode and logs the count of dangling surfaces. A non-zero count is a signal for the owner
 * to run the (human-gated) backfill; the sweep itself never writes.
 */
export function buildMergeAttributionSweepHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runMergeAttributionBackfill(db, { dryRun: true });
      if (result.orphanSurfacesFound > 0) {
        console.warn(
          '[merge_attribution_sweep] RESIDUAL ORPHANS FOUND — run pnpm tsx scripts/backfill-merge-attribution.ts',
          {
            scannedFromIds: result.scannedFromIds,
            resolved: result.resolved,
            skipped: result.skipped,
            orphanSurfacesFound: result.orphanSurfacesFound,
          },
        );
      } else {
        console.log('[merge_attribution_sweep] clean — no dangling merge-attribution surfaces', {
          scannedFromIds: result.scannedFromIds,
          skipped: result.skipped,
        });
      }
    } catch (err) {
      console.error('[merge_attribution_sweep] failed', err);
      throw err;
    }
  };
}
