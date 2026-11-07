// YUK-1994 — explicit legacy annotation backfill, never the cron.
//
// The scheduled sweep only selects questions whose `ingestion_enrollment`
// marker already carries the slice-3 `solution` key, so pre-slice-3 inventory
// is deliberately unreachable by the sweep: re-annotating it is a paid,
// one-time operator decision. This script is that decision's entry point —
// the migration lane runs it, nothing schedules it.
//
// CLI:
//   pnpm db:backfill:annotation-legacy                  # dry-run census (zero writes)
//   pnpm db:backfill:annotation-legacy -- --apply        # paid run on the censused ids
//   pnpm db:backfill:annotation-legacy -- --apply --limit 50
//
// --apply feeds the censused ids to `runAnnotationBackfill` as an explicit
// `questionIds` run, so every per-row guard still applies: usage policy
// (restricted/unresolvable never sends), the figure-dependent skip, the paid
// attempt budget, infra backoff, and the CAS write discipline. Re-run until the
// census is empty; each run processes at most `--limit` rows (default 25).
//
// Load `.env` BEFORE importing `@/db/client` (same pattern as the other
// backfill scripts); the db import stays lazy inside main().
import './load-env';

import { sql } from 'drizzle-orm';
import { notDraftPredicate } from '@/db/predicates';
import { question } from '@/db/schema';

export const DEFAULT_LIMIT = 25;

/** Parse `--limit=<n>` / `--limit <n>`; invalid values warn and fall back. */
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
      `[backfill-annotation-legacy] ignoring invalid --limit "${raw}"; using default ${DEFAULT_LIMIT}.`,
    );
    return DEFAULT_LIMIT;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    console.warn(
      `[backfill-annotation-legacy] ignoring invalid --limit "${raw}"; using default ${DEFAULT_LIMIT}.`,
    );
    return DEFAULT_LIMIT;
  }
  return n;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = !argv.includes('--apply');
  const limit = parseLimit(argv);

  const { db } = await import('@/db/client');
  const { runAnnotationBackfill } = await import(
    '@/capabilities/ingestion/server/annotation-backfill'
  );

  // Census = ingestion-enrolled rows that predate the slice-3 `solution` marker
  // and are pool-visible; the sweep's marker filter can never reach them.
  const eligible = sql`(
    coalesce(${question.metadata}->'ingestion_enrollment'->>'solution', 'missing') = 'missing'
    and ${question.metadata}->>'solution_annotation' is null
  ) or (
    ${question.metadata}->'ingestion_enrollment'->>'knowledge' = 'missing'
    and jsonb_array_length(${question.knowledge_ids}) = 0
  )`;
  const censused = await db
    .select({ id: question.id })
    .from(question)
    .where(
      sql`${question.metadata} ? 'ingestion_enrollment'
        and not (${question.metadata}->'ingestion_enrollment' ? 'solution')
        and (${notDraftPredicate(question.draft_status)})
        and (${eligible})`,
    )
    .orderBy(question.created_at, question.id)
    .limit(limit);

  if (dryRun) {
    console.log(
      `[backfill-annotation-legacy] dry-run — ${censused.length} legacy question(s) eligible ` +
        `(limit ${limit}). Re-run with --apply to annotate; ids:`,
    );
    for (const row of censused) console.log(`  ${row.id}`);
    return 0;
  }
  if (censused.length === 0) {
    console.log('[backfill-annotation-legacy] nothing eligible; done.');
    return 0;
  }

  const result = await runAnnotationBackfill({
    db,
    questionIds: censused.map((r) => r.id),
    limit,
  });
  console.log(
    `[backfill-annotation-legacy] apply — scanned=${result.scanned} ` +
      `knowledge_filled=${result.knowledge_filled} knowledge_repaired=${result.knowledge_repaired} ` +
      `solution_filled=${result.solution_filled} policy_blocked=${result.policy_blocked} ` +
      `infra_failures=${result.infra_failures} exhausted=${result.exhausted} ` +
      `skipped=${result.solution_skipped} failed=${result.knowledge_failed + result.solution_failed}`,
  );
  return 0;
}

if (
  typeof process.argv[1] === 'string' &&
  process.argv[1].endsWith('backfill-annotation-legacy.ts')
) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[backfill-annotation-legacy] failed:', err);
      process.exit(1);
    });
}
