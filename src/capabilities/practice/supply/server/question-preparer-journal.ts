import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs, event, tool_call_log } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { lockQuestionSubmitRequest } from '@/kernel/locks/question-supply';
import { unknownAttemptCostTruth } from '@/server/ai/attempt-cost';
import { writeAiTaskAttemptFinished } from '@/server/ai/log';
import { fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import {
  type QuestionPreparerData,
  QuestionPreparerJobData,
  preparerTerminal,
} from './question-preparer-contract';
import { settleNightlySourcingRun } from './spend-gate';

const action = 'experimental:question_preparer';
export const preparerSpendKey = (jobId: string) => `question_preparer:${jobId}`;
export function defectIdentity(data: QuestionPreparerData): string | null {
  const v = data.continuation?.verdict;
  if (!v) return null;
  return createHash('sha256')
    .update(
      JSON.stringify([
        v.question_id,
        v.scoring_unit_id,
        v.repair.repair_target,
        v.repair.broken_part.trim(),
        v.repair.defect.trim(),
      ]),
    )
    .digest('hex');
}
export function preparerLockKey(data: QuestionPreparerData): string {
  return data.continuation
    ? `question:${data.continuation.verdict.question_id}`
    : `ticket:${data.ticket.demand_id}`;
}
export async function preparerRecord(
  db: Db | Tx,
  jobId: string,
  data: QuestionPreparerData,
  state: 'unstarted' | 'started_unknown' | 'run_registered' | 'finished',
  extra: Record<string, unknown> = {},
) {
  const runId = typeof extra.run_id === 'string' ? extra.run_id : '';
  const id = `question_preparer_${state}_${jobId}${runId ? `_${runId}` : ''}`;
  const now = new Date();
  await writeEvent(db, {
    id,
    action,
    actor_kind: 'agent',
    actor_ref: 'question_preparer',
    subject_kind: 'query',
    subject_id: data.ticket.demand_id,
    outcome: state,
    payload: {
      data,
      job_id: jobId,
      lock_key: preparerLockKey(data),
      defect_identity: defectIdentity(data),
      ...extra,
    },
    task_run_id: `question_preparer_${jobId}`,
    caused_by_event_id: null,
    cost_micro_usd: null,
    session_id: null,
    created_at: now,
    ingest_at: now,
  });
}
export async function preparerHistory(db: Db | Tx, data: QuestionPreparerData) {
  return db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, action),
        sql`(${event.subject_id} = ${data.ticket.demand_id} OR ${event.payload}->>'lock_key' = ${preparerLockKey(data)})`,
      ),
    )
    .orderBy(event.created_at, event.id);
}
export async function preparerFinish(
  db: Db | Tx,
  jobId: string,
  data: QuestionPreparerData,
  outcome: 'done' | 'no_progress' | 'awaiting_admission',
  summary: string,
  retryable = false,
) {
  const terminal = preparerTerminal.parse({
    ticket: data.ticket,
    task_run_id: `question_preparer_${jobId}`,
    outcome,
    summary,
    retryable,
  });
  await preparerRecord(db, jobId, data, 'finished', { terminal });
  return terminal;
}
export async function preparerCalls(db: Db | Tx, taskRunId: string) {
  return db
    .select()
    .from(tool_call_log)
    .where(eq(tool_call_log.task_run_id, taskRunId))
    .orderBy(tool_call_log.occurred_at);
}

/** Receipts commit with publication; tool logging may lag a process death. */
export async function preparerSubmittedRevisions(db: Db | Tx, taskRunId: string) {
  const receipts = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(eq(event.action, 'experimental:question_draft_submit'), eq(event.task_run_id, taskRunId)),
    );
  return new Set(
    receipts.flatMap((row) => {
      const receipt = row.payload.receipt;
      return receipt &&
        typeof receipt === 'object' &&
        'revision_id' in receipt &&
        typeof receipt.revision_id === 'string'
        ? [receipt.revision_id]
        : [];
    }),
  );
}

/** Queue truth proves a segment dead. Unknown requests are settled, never replayed. */
export async function recoverQuestionPreparer(db: Db, jobId: string, forceDead = false) {
  const [claim] = await db
    .select()
    .from(event)
    .where(eq(event.id, `question_preparer_unstarted_${jobId}`));
  if (!claim) return;
  const data = QuestionPreparerJobData.parse(claim.payload.data);
  const boss = await getStartedBoss();
  const job = await boss.getJobById('question_preparer_run', jobId);
  if (!forceDead && job && ['created', 'retry', 'active'].includes(job.state)) return;
  await db.transaction(async (tx) => {
    await lockQuestionSubmitRequest(tx, `question_preparer:${preparerLockKey(data)}`);
    const history = await preparerHistory(tx, data);
    if (history.some((row) => row.id === `question_preparer_finished_${jobId}`)) return;
    const started = history.some((row) => row.id === `question_preparer_started_unknown_${jobId}`);
    const registered = history
      .filter((row) => row.outcome === 'run_registered' && row.payload.job_id === jobId)
      .flatMap((row) => (typeof row.payload.run_id === 'string' ? [row.payload.run_id] : []));
    const runIds = [
      ...new Set([...registered, ...(started ? [`question_preparer_${jobId}`] : [])]),
    ];
    const calls = await preparerCalls(tx, `question_preparer_${jobId}`);
    const revisions = new Set(
      calls.flatMap((call) =>
        call.tool_name.endsWith('submit_question') &&
        typeof call.output_json?.revision_id === 'string'
          ? [call.output_json.revision_id]
          : [],
      ),
    );
    for (const revision of await preparerSubmittedRevisions(tx, `question_preparer_${jobId}`))
      revisions.add(revision);
    if (runIds.length) {
      const rows = await tx.select().from(ai_task_runs).where(inArray(ai_task_runs.id, runIds));
      for (const run of rows.filter((row) => row.status === 'running')) {
        await writeAiTaskAttemptFinished(db, {
          id: run.id,
          status: 'failure',
          finish_reason: 'process_interrupted_unknown',
          usage: { inputTokens: 0, outputTokens: 0 },
          cost_truth: unknownAttemptCostTruth(run.provider, run.model),
          outcome: 'failed_permanent',
          error_message:
            'pg-boss confirms the owning segment is dead; paid request outcome unknown',
          finished_at: new Date(),
        });
      }
    }
    // Spend locking is owned by the ledger in its own transaction, before terminal publication.
    await settleNightlySourcingRun(db, {
      targetId: preparerSpendKey(jobId),
      taskRunIds: runIds,
      submittedCount: revisions.size,
      interruptedUnknown: started,
    });
    await preparerFinish(
      tx,
      jobId,
      data,
      'no_progress',
      started
        ? 'process_interrupted_unknown; prior paid requests must not be resent'
        : 'process_interrupted_before_provider',
      true,
    );
    await boss.send(
      'question_preparer_run',
      { ...data, recovery: { prior_job_id: jobId } },
      {
        db: fromPgBossDrizzleTx(tx),
        singletonKey: `question_preparer_recovery:${jobId}`,
      },
    );
  });
}

export function buildQuestionPreparerRecoveryHandler(db: Db) {
  return async () => {
    const claims = await db
      .select({ jobId: sql<string>`${event.payload}->>'job_id'` })
      .from(event)
      .where(
        and(
          eq(event.action, action),
          eq(event.outcome, 'unstarted'),
          sql`NOT EXISTS (SELECT 1 FROM event terminal WHERE terminal.id = 'question_preparer_finished_' || (${event.payload}->>'job_id'))`,
        ),
      );
    for (const claim of claims) await recoverQuestionPreparer(db, claim.jobId);
  };
}
