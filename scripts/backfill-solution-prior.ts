// One-off ops CLI: backfill the solution prior for already admitted questions.
//
//   pnpm db:backfill:solution-prior                                # census: no writes, no spend
//   pnpm db:backfill:solution-prior --apply --limit 100            # paid; then fills vectors
//   pnpm db:backfill:solution-prior --apply --retry-unproduced     # pays again for groups that
//                                                                  # produced nothing last time
//   pnpm db:backfill:solution-prior --revert <run_id>              # lists what a revert removes
//   pnpm db:backfill:solution-prior --revert <run_id> --apply
//
// Each group is paid for once unless --retry-unproduced is given. Task runners log to stdout
// too, so the receipt is the last line: pipe through `tail -1`.
import { randomUUID } from 'node:crypto';
import './load-env';

function parseArgs(argv: string[]) {
  const args = {
    apply: false,
    limit: 25,
    retryUnproduced: false,
    revert: undefined as string | undefined,
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--retry-unproduced') {
      args.retryUnproduced = true;
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
    const census = await backfill.censusSolutionPriorBackfill(db, {
      retryUnproduced: args.retryUnproduced,
    });
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
  // Printed first: a crash midway must still leave the id a revert needs.
  console.log(JSON.stringify({ backfill_run_id: backfillRunId, started: true }));
  const outcome = await backfill.applySolutionPriorBackfill(db, {
    backfillRunId,
    limit: args.limit,
    retryUnproduced: args.retryUnproduced,
  });
  // A bigger deadline than the nightly job's, so the window finishes in one go.
  const { embedSolutionPriorVectors } = await import(
    '@/capabilities/practice/question-bank/server/admission/solution-prior-vectors'
  );
  // The paid results are already committed: a vector failure must not lose their receipt.
  // The nightly sweep picks up whatever is left.
  const vectors = await embedSolutionPriorVectors(db, args.limit * 4, {
    db,
    caller: 'worker',
    deadlineAt: new Date(Date.now() + 10 * 60_000),
  }).then(
    (written) => ({ vectors_written: written }),
    (error: unknown) => ({
      vectors_error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
    }),
  );
  console.log(JSON.stringify({ backfill_run_id: backfillRunId, ...vectors, ...outcome }));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
