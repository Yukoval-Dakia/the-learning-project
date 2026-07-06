// YUK-379 (B1) — one-time backfill CLI: re-drive attribution for failure
// attempts silently lost by the pre-fix swallow bug.
//
// The pipeline lives in the capability module (lost-attribution-backfill.ts) so
// the DB test drives it against the testcontainer; this script's main()/auto-run
// only fires as the CLI entry point.
//
// CLI:
//   pnpm tsx scripts/backfill-lost-attribution.ts               # dry-run census (zero writes)
//   pnpm tsx scripts/backfill-lost-attribution.ts --apply       # enqueue attribution_followup jobs
//   pnpm tsx scripts/backfill-lost-attribution.ts --apply --limit 50   # override per-run cap (default 25)
//
// The enqueued attribution_followup job is idempotent (getJudgeForAttempt skips
// when a real judge already exists), so re-running --apply never double-judges.

// Load `.env` BEFORE importing `@/db/client` (the client throws on a missing
// DATABASE_URL at construction). Scripts load `.env`, NOT `.env.local`.
import './load-env';

import { runLostAttributionBackfill } from '@/capabilities/knowledge/server/lost-attribution-backfill';
import { db } from '@/db/client';

const DEFAULT_LIMIT = 25;

function parseLimit(argv: string[]): number {
  const eqArg = argv.find((a) => a.startsWith('--limit='));
  if (eqArg) {
    const n = Number(eqArg.slice('--limit='.length));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
  }
  const idx = argv.indexOf('--limit');
  if (idx !== -1 && idx + 1 < argv.length) {
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
  }
  return DEFAULT_LIMIT;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = !argv.includes('--apply');
  const limit = parseLimit(argv);

  let send: ((attemptEventId: string) => Promise<void>) | undefined;
  if (!dryRun) {
    const { getStartedBoss } = await import('@/server/boss/client');
    const boss = await getStartedBoss();
    send = async (attemptEventId: string) => {
      await boss.send('attribution_followup', { attempt_event_id: attemptEventId });
    };
  }

  const result = await runLostAttributionBackfill({ db, dryRun, limit, send });
  console.log(
    `[backfill-lost-attribution] mode=${result.mode} limit=${limit} — found ${result.found} lost attempt(s), ` +
      `enqueued ${result.enqueued}.`,
  );
  if (result.attemptIds.length > 0) {
    console.log(`[backfill-lost-attribution] attempt ids: ${result.attemptIds.join(', ')}`);
  }
}

if (
  typeof process.argv[1] === 'string' &&
  process.argv[1].endsWith('backfill-lost-attribution.ts')
) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[backfill-lost-attribution] failed:', err);
      process.exit(1);
    });
}
