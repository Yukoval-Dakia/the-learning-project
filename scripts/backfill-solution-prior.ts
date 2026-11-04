// One-off ops CLI: backfill the solution prior for already admitted questions.
//
//   pnpm db:backfill:solution-prior                                # census: no writes, no spend
//   pnpm db:backfill:solution-prior --apply --limit 100            # paid; prints a run id
//   pnpm db:backfill:solution-prior --revert <run_id>              # lists what a revert removes
//   pnpm db:backfill:solution-prior --revert <run_id> --apply
//
// Task runners log to stdout too, so the receipt is the last line: pipe through `tail -1`.
import { randomUUID } from 'node:crypto';
import './load-env';

function parseArgs(argv: string[]) {
  const args = { apply: false, limit: 25, revert: undefined as string | undefined };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--limit' || arg === '--revert') {
      const value = rest.shift();
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--revert') {
        args.revert = value;
      } else {
        if (!/^[1-9]\d{0,3}$/.test(value)) throw new Error('--limit must be 1-9999');
        args.limit = Number(value);
      }
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { db } = await import('@/db/client');
  const backfill = await import(
    '@/capabilities/practice/question-bank/server/admission/solution-prior-backfill'
  );
  if (args.revert != null) {
    const rows = await backfill.revertSolutionPriorBackfill(db, {
      backfillRunId: args.revert,
      apply: args.apply,
    });
    console.log(JSON.stringify({ reverted: args.apply, count: rows.length, rows }));
    return;
  }
  if (!args.apply) {
    const census = await backfill.censusSolutionPriorBackfill(db);
    console.log(
      JSON.stringify({
        eligible_count: census.eligible.length,
        excluded_counts: Object.fromEntries(
          Object.entries(census.excluded).map(([reason, ids]) => [reason, ids?.length ?? 0]),
        ),
        ...census,
      }),
    );
    return;
  }
  const { hydrateConfigFromDb } = await import('@/server/config/hydrate');
  const { hydrateModelCatalog } = await import('@/server/ai/model-catalog');
  await hydrateConfigFromDb(db);
  await hydrateModelCatalog(db);
  const backfillRunId = `prior-backfill-${randomUUID()}`;
  const outcome = await backfill.applySolutionPriorBackfill(db, {
    backfillRunId,
    limit: args.limit,
  });
  console.log(JSON.stringify({ backfill_run_id: backfillRunId, ...outcome }));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
