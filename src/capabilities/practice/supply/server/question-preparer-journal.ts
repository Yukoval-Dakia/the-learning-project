import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db, Tx } from '@/db/client';
import {
  ai_task_runs,
  event,
  question_group_lifecycle,
  question_revision,
  tool_call_log,
} from '@/db/schema';
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
export function defectCategory(data: QuestionPreparerData): string | null {
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
/** Relevant unit content, excluding sibling units, revision ids, timestamps and hint wording. */
function unitDigest(
  revision: typeof question_revision.$inferSelect,
  unitId: string,
): string | null {
  const unit = revision.scoring_basis.units.find((item) => item.scoring_unit_id === unitId);
  if (!unit) return null;
  const slotIds = new Set([...unit.slot_refs, ...unit.evidence_slot_refs]);
  const slots = revision.response_spec.slots.filter((slot) => slotIds.has(slot.slot_id));
  const partIds = new Set(slots.map((slot) => slot.part_id));
  const parts = revision.structure.parts.filter((part) => partIds.has(part.part_id));
  const materialIds = new Set([
    ...unit.material_refs,
    ...parts.flatMap((part) => part.material_ids),
  ]);
  return canonicalHash({
    unit,
    slots,
    parts: parts.map(({ part_id, prompt_md, material_ids, blank_order }) => ({
      part_id,
      prompt_md,
      material_ids,
      blank_order,
    })),
    materials: revision.structure.materials.filter((material) =>
      materialIds.has(material.material_id),
    ),
    executors: revision.execution_plan.assignments
      .filter((assignment) => assignment.scoring_unit_ids.includes(unitId))
      .map((assignment) => assignment.executor),
    blank_scores_zero: revision.scoring_basis.blank_scores_zero,
  });
}

export async function preparerUnitContent(
  db: Db | Tx,
  questionId: string,
  unitId: string,
  revisionId?: string,
) {
  const [row] = revisionId
    ? await db
        .select()
        .from(question_revision)
        .where(
          and(
            eq(question_revision.group_id, questionId),
            eq(question_revision.revision_id, revisionId),
          ),
        )
    : await db
        .select({ revision: question_revision })
        .from(question_group_lifecycle)
        .innerJoin(
          question_revision,
          eq(question_revision.revision_id, question_group_lifecycle.current_revision_id),
        )
        .where(eq(question_group_lifecycle.group_id, questionId))
        .then((rows) => rows.map((item) => item.revision));
  if (!row) return null;
  const digest = unitDigest(row, unitId);
  return digest ? { digest, revision_id: row.revision_id } : null;
}

export function preparerLockKey(data: QuestionPreparerData): string {
  return data.continuation
    ? `question:${data.continuation.verdict.question_id}`
    : `ticket:${data.ticket.demand_id}`;
}
/** All segment fences acquire ticket first, then question; never hold either across a model call. */
export async function lockQuestionPreparerSegment(tx: Tx, data: QuestionPreparerData) {
  await lockQuestionSubmitRequest(tx, `question_preparer:ticket:${data.ticket.demand_id}`);
  if (data.continuation)
    await lockQuestionSubmitRequest(
      tx,
      `question_preparer:question:${data.continuation.verdict.question_id}`,
    );
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
      defect_category: defectCategory(data),
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
        typeof receipt.revision_id === 'string' &&
        (('publish_status' in receipt && receipt.publish_status === 'published') ||
          ('published' in receipt && receipt.published === true))
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
    await lockQuestionPreparerSegment(tx, data);
    const history = await preparerHistory(tx, data);
    if (history.some((row) => row.id === `question_preparer_finished_${jobId}`)) return;
    const started = history.some((row) => row.id === `question_preparer_started_unknown_${jobId}`);
    const registered = history
      .filter((row) => row.outcome === 'run_registered' && row.payload.job_id === jobId)
      .flatMap((row) => (typeof row.payload.run_id === 'string' ? [row.payload.run_id] : []));
    const runIds = [
      ...new Set([...registered, ...(started ? [`question_preparer_${jobId}`] : [])]),
    ];
    const revisions = await preparerSubmittedRevisions(tx, `question_preparer_${jobId}`);
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
