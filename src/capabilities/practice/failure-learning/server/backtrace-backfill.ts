import { and, asc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { attempt_insight_vector, event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { backtraceDigest, loadBacktraceInput } from './backtrace-input';
import { currentInsight } from './backtrace-store';
import { writeAttemptInsight, writeBacktraceJudgement } from './backtrace-writer';

/** Migration owner runs this against an explicitly selected target; no ambient env loading. */
export async function backfillBacktrace(
  db: Db,
  opts: {
    apply: boolean;
    limit: number;
    run_id: string;
    before: Date;
    after?: { created_at: Date; id: string };
  },
) {
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 100)
    throw new Error('limit must be 1..100');
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        inArray(event.action, ['attempt', 'review', 'experimental:assessment_attempt']),
        lt(event.created_at, opts.before),
        opts.after
          ? or(
              gt(event.created_at, opts.after.created_at),
              and(eq(event.created_at, opts.after.created_at), gt(event.id, opts.after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id))
    .limit(opts.limit);
  const receipt = [];
  for (const row of rows) {
    const basis = await loadBacktraceInput(db, row.id);
    const insight = basis ? await currentInsight(db, row.id) : null;
    receipt.push({
      attempt_event_id: row.id,
      action: row.action,
      eligible: !!basis,
      missing_insight: !!basis && !insight,
      image_status: basis?.input.image_status ?? null,
      input_digest: basis?.digest ?? null,
    });
    if (opts.apply && basis) {
      await writeAttemptInsight(db, row.id, opts.run_id);
      await writeBacktraceJudgement(db, row.id);
    }
  }
  const last = rows.at(-1);
  return {
    run_id: opts.run_id,
    receipt,
    next: last ? { created_at: last.created_at, id: last.id } : null,
  };
}

export async function revertBacktraceBackfill(db: Db, runId: string) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:attempt_insight'));
    const reverted = rows.filter((x) => x.payload.backfill_run_id === runId);
    for (const row of reverted) {
      await writeEvent(tx, {
        id: `backtrace-revert:${backtraceDigest({ runId, id: row.id })}`,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: row.id,
        outcome: 'success',
        payload: {
          correction_kind: 'retract',
          reason_md: 'Backfill run reverted',
          affected_refs: [{ kind: 'question', id: String(row.payload.question_id) }],
        },
      });
      await tx
        .delete(attempt_insight_vector)
        .where(eq(attempt_insight_vector.insight_event_id, row.id));
    }
    return reverted.map((x) => x.id);
  });
}
