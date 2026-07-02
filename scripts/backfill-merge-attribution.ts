// YUK-543 — one-time backfill: repair merge-attribution for PRE-FIX history.
//
// Merges accepted before YUK-543 archived a `from` KC + appended into.merged_from[] but left the
// downstream attribution surfaces (question/learning_item/goal knowledge_ids, knowledge_edge
// endpoints, mastery/fsrs/axis/kc_typed per-KC state, misconception edge targets) pointing at the
// now-archived id. This script resolves every absorbed KC to its terminal LIVE winner (walking the
// merged_from chain, spec §4 decision 4b — an archived-not-merged terminal or a cycle is logged +
// skipped, never guessed) and repairs each surface via the SAME repairMergeAttributionForFromId that
// applyMerge uses (never raw table writes → guard-compliant).
//
// IDEMPOTENT: every repair helper queries "rows still referencing fromId" and no-ops when none exist,
// so a second run repairs nothing (the DB test asserts a clean second pass).
//
// CLI:
//   pnpm tsx scripts/backfill-merge-attribution.ts            # repair
//   pnpm tsx scripts/backfill-merge-attribution.ts --dry-run  # census only (zero writes)
//
// The pipeline lives in the capability module (merge-attribution-backfill.ts) so the DB test drives
// it against the testcontainer; this script's main()/auto-run only fires as the CLI entry point.

// Load `.env` BEFORE importing `@/db/client` (the client throws on a missing DATABASE_URL at
// construction). Scripts load `.env`, NOT `.env.local`.
import './load-env';

import { runMergeAttributionBackfill } from '@/capabilities/knowledge/server/merge-attribution-backfill';
import { db } from '@/db/client';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const result = await runMergeAttributionBackfill(db, { dryRun });
  console.log(
    `[backfill-merge-attribution] mode=${dryRun ? 'dry-run' : 'repair'} — scanned ${result.scannedFromIds} absorbed id(s), ` +
      `${result.winners} winner(s), resolved ${result.resolved}, skipped ${result.skipped}, ` +
      `orphan surfaces ${dryRun ? 'found' : 'repaired'} ${result.orphanSurfacesFound}.`,
  );
}

if (
  typeof process.argv[1] === 'string' &&
  process.argv[1].endsWith('backfill-merge-attribution.ts')
) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[backfill-merge-attribution] failed:', err);
      process.exit(1);
    });
}
