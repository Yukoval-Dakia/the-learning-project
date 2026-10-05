import { and, count, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { copilot_continuation, subagent_run } from '@/db/schema';
import { nativeSubagentProjectionCondition } from './subagent-mailbox';

/** Deployment refusal only: never cancel work, delete history, or start a provider. */
export async function assertCopilotLegacyDrained(db: Db): Promise<void> {
  const [children] = await db
    .select({ count: count() })
    .from(subagent_run)
    .where(
      and(
        inArray(subagent_run.status, ['queued', 'running']),
        sql`NOT (${nativeSubagentProjectionCondition()})`,
      ),
    );
  const [continuations] = await db
    .select({ count: count() })
    .from(copilot_continuation)
    .where(inArray(copilot_continuation.status, ['pending', 'running']));
  const [schema] = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') AS present
  `);
  let jobs = 0;
  let schedules = 0;
  if (schema?.present) {
    // Missing pg-boss tables in an existing namespace are an error, not a fresh DB.
    const [pending] = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM pgboss.job
      WHERE name IN ('copilot_subagent_run', 'copilot_continuation',
        'copilot_subagent_run_dlq', 'copilot_continuation_dlq', 'copilot_subagent_reconcile')
        AND state IN ('created', 'retry', 'active')
    `);
    const [scheduled] = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM pgboss.schedule WHERE name = 'copilot_subagent_reconcile'
    `);
    jobs = pending?.count ?? 0;
    schedules = scheduled?.count ?? 0;
  }
  if (children?.count || continuations?.count || jobs || schedules) {
    throw new Error(
      `Copilot legacy drain required: ${JSON.stringify({
        children: children?.count ?? 0,
        continuations: continuations?.count ?? 0,
        jobs,
        schedules,
      })}. Keep the previous worker to drain legacy work; unschedule copilot_subagent_reconcile ` +
        'and drain its queued housekeeping ticks before upgrading. Do not delete pending work.',
    );
  }
}
