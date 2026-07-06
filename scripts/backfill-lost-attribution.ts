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
//
// RACE GUARD (--apply): the census applies a created_at floor of NOW - 6h (OCR
// #1), so a brand-new failure attempt whose ORIGINAL attribution_followup job is
// still enqueued/in-flight is NOT censused and cannot be re-enqueued. That
// programmatically closes the read-then-write double-judge race (the idempotency
// check has no unique constraint on caused_by_event_id → both reads could miss →
// double judge + double LLM), replacing the previous ops-discipline-only rule.
// Still best run after a dry-run census review.

// Load `.env` BEFORE importing `@/db/client` (the client throws on a missing
// DATABASE_URL at construction). Scripts load `.env`, NOT `.env.local`. The
// `@/db/client` import is lazy (inside main) so this module — and its pure
// `parseLimit` — stays importable in the unit test without a DATABASE_URL.
import './load-env';

import {
  type EnqueueAttributionFollowupFn,
  runLostAttributionBackfill,
} from '@/capabilities/knowledge/server/lost-attribution-backfill';

export const DEFAULT_LIMIT = 25;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * Parse `--limit=<n>` / `--limit <n>`. A MISSING flag silently uses
 * {@link DEFAULT_LIMIT}; a PRESENT-but-invalid value is an operator mistake, so
 * it warns before falling back (OCR #2) rather than silently degrading a
 * production backfill.
 *
 * Round-2 OCR: `Number(raw)` accepted non-decimal forms a CLI operator would
 * never intend as a count — hex (`0x10` -> 16), scientific notation (`1e2` ->
 * 100), fractionals silently floored. `raw` must match `/^\d+$/` (plain
 * unsigned decimal digits only) before `parseInt(raw, 10)`; anything else, or a
 * non-positive result, warns and falls back to {@link DEFAULT_LIMIT}.
 */
export function parseLimit(argv: string[]): number {
  let raw: string | undefined;
  const eqArg = argv.find((a) => a.startsWith('--limit='));
  if (eqArg) {
    raw = eqArg.slice('--limit='.length);
  } else {
    const idx = argv.indexOf('--limit');
    if (idx !== -1 && idx + 1 < argv.length) raw = argv[idx + 1];
  }
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) {
    console.warn(
      `[backfill-lost-attribution] ignoring invalid --limit "${raw}"; using default ${DEFAULT_LIMIT}.`,
    );
    return DEFAULT_LIMIT;
  }
  const n = Number.parseInt(raw, 10);
  if (n <= 0) {
    console.warn(
      `[backfill-lost-attribution] ignoring invalid --limit "${raw}"; using default ${DEFAULT_LIMIT}.`,
    );
    return DEFAULT_LIMIT;
  }
  return n;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = !argv.includes('--apply');
  const limit = parseLimit(argv);
  // OCR #1: floor the census at NOW - 6h so a fresh attempt whose original
  // attribution_followup job may still be in flight is never re-enqueued (see the
  // RACE GUARD note above). 6h clears any realistic queue backlog + retry window.
  const createdBefore = new Date(Date.now() - SIX_HOURS_MS);

  const { db } = await import('@/db/client');

  let send: EnqueueAttributionFollowupFn | undefined;
  if (!dryRun) {
    const { getStartedBoss } = await import('@/server/boss/client');
    const boss = await getStartedBoss();
    send = async (attemptEventId: string) => {
      await boss.send('attribution_followup', { attempt_event_id: attemptEventId });
    };
  }

  const result = await runLostAttributionBackfill({ db, dryRun, limit, createdBefore, send });
  console.log(
    `[backfill-lost-attribution] mode=${result.mode} limit=${limit} — found ${result.found} lost attempt(s), ` +
      `enqueued ${result.enqueued}.`,
  );
  if (result.attemptIds.length > 0) {
    console.log(`[backfill-lost-attribution] attempt ids: ${result.attemptIds.join(', ')}`);
  }
  // OCR #3: consume the pipeline's per-item enqueue failures (implemented once,
  // in runLostAttributionBackfill) — print each and exit non-zero so a partial
  // backfill is never mistaken for a clean run.
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      console.error(
        `[backfill-lost-attribution] enqueue failed for ${e.attemptEventId}: ${e.message}`,
      );
    }
    return 1;
  }
  return 0;
}

if (
  typeof process.argv[1] === 'string' &&
  process.argv[1].endsWith('backfill-lost-attribution.ts')
) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[backfill-lost-attribution] failed:', err);
      process.exit(1);
    });
}
