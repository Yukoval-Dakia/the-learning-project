import { randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL) throw new Error('explicit DATABASE_URL required');
const { db } = await import('@/db/client');
const { backfillBacktrace, revertBacktraceBackfill } = await import(
  '@/capabilities/practice/failure-learning/server/backtrace-backfill'
);
const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const runId = value('--run-id') ?? randomUUID();
const revert = value('--revert');
const afterId = value('--after-id');
const afterTime = value('--after-time');
if (!!afterId !== !!afterTime || (afterTime && !Number.isFinite(Date.parse(afterTime))))
  throw new Error('cursor requires a valid --after-time and --after-id');
try {
  if (revert)
    console.log(
      JSON.stringify({ run_id: revert, reverted: await revertBacktraceBackfill(db, revert) }),
    );
  else
    console.log(
      JSON.stringify(
        await backfillBacktrace(db, {
          apply: args.includes('--apply'),
          limit: Number(value('--limit') ?? '25'),
          run_id: runId,
          before: new Date(Date.now() - 6 * 3600_000),
          ...(afterId && afterTime
            ? { after: { id: afterId, created_at: new Date(afterTime) } }
            : {}),
        }),
      ),
    );
} finally {
  await db.$client.end();
}
