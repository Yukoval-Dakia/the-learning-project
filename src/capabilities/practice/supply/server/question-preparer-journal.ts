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
import { writeAiTaskAttemptFinished } from '@/kernel/records/ai-attempt-facts';
import { readTaskRunPublications } from '@/kernel/records/publication-receipt';
import { unknownAttemptCostTruth } from '@/server/ai/attempt-cost';
import { getStartedBoss } from '@/server/boss/client';
import {
  type QuestionPreparerData,
  QuestionPreparerJobData,
  preparerTerminal,
} from './question-preparer-contract';
import { settleNightlySourcingRun } from './spend-gate';
import {
  type SupplyDeliveryBoss,
  type SupplyDeliveryOptions,
  readSupplyDelivery,
  selectPendingSupplyDeliveries,
  sendSupplyDelivery,
  supplyDeliveryJobId,
  writeSupplyDeliveryIntent,
  writeSupplyDeliveryReceipt,
} from './supply-delivery-outbox';

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
  inventory?: import('zod').infer<
    typeof import('./question-preparer-contract').preparerInventoryObservation
  >,
) {
  const terminal = preparerTerminal.parse({
    ticket: data.ticket,
    ...(data.ticket_event_id ? { ticket_event_id: data.ticket_event_id } : {}),
    task_run_id: `question_preparer_${jobId}`,
    outcome,
    summary,
    retryable,
    ...(inventory ? { inventory } : {}),
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

/**
 * Bind a successor segment delivery in the segment's own transaction. The finished record and the
 * successor intent commit together, so a finished prior can never strand its successor; the drain
 * sends after commit.
 */
export async function bindQuestionPreparerDelivery(
  tx: Tx,
  input: {
    jobId: string;
    data: QuestionPreparerData;
    options?: SupplyDeliveryOptions;
  },
): Promise<string> {
  await writeSupplyDeliveryIntent(tx, {
    domain: 'question_preparer',
    subjectId: input.data.ticket.demand_id,
    queue: 'question_preparer_run',
    jobId: input.jobId,
    data: input.data,
    options: input.options ?? {},
  });
  return input.jobId;
}

export interface QuestionPreparerDeliveryDrainResult {
  scanned: number;
  sent: number;
  settled: number;
  failed: number;
}

/**
 * The segment journal's single sender and delivery recovery owner. An intent stays open until the
 * journal records its job id or the engine reports the job terminal, because an accepted job the
 * engine drops before any worker fetched it (retention, restore) would otherwise strand a ticket
 * behind its cooldown or a finished prior without its successor. Re-sending reuses the bound id:
 * nothing paid exists under it until the journal's unstarted claim, and the engine dedups a held
 * id. Started segments stay with `recoverQuestionPreparer`.
 */
export async function drainQuestionPreparerDeliveries(
  db: Db,
  boss: SupplyDeliveryBoss,
  input: { jobId?: string; limit?: number } = {},
): Promise<QuestionPreparerDeliveryDrainResult> {
  const rows = await selectPendingSupplyDeliveries(db, {
    domain: 'question_preparer',
    closedBy: ['settled'],
    jobId: input.jobId,
    limit: input.limit ?? 50,
  });
  const result = { scanned: rows.length, sent: 0, settled: 0, failed: 0 };
  for (const intent of rows) {
    try {
      const journaled = await db
        .select({ id: event.id })
        .from(event)
        .where(
          inArray(event.id, [
            `question_preparer_unstarted_${intent.job_id}`,
            `question_preparer_finished_${intent.job_id}`,
          ]),
        )
        .limit(1);
      if (journaled.length > 0) {
        await writeSupplyDeliveryReceipt(db, intent, 'settled', { by: 'journal' });
        result.settled += 1;
        continue;
      }
      let truth = await readSupplyDelivery(boss, intent);
      if (truth.kind === 'absent') {
        truth = await sendSupplyDelivery(boss, intent);
        if (truth.kind !== 'absent') result.sent += 1;
      }
      if (truth.kind === 'absent') {
        result.failed += 1;
        continue;
      }
      await writeSupplyDeliveryReceipt(db, intent, 'accepted', { engine_state: truth.state });
      if (truth.kind === 'terminal') {
        await writeSupplyDeliveryReceipt(db, intent, 'settled', {
          by: 'engine',
          engine_state: truth.state,
        });
        result.settled += 1;
      }
    } catch (error) {
      result.failed += 1;
      console.error('[question-preparer] delivery send failed; intent stays pending', {
        job_id: intent.job_id,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
  }
  return result;
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
  const successor = await db.transaction(async (tx) => {
    await lockQuestionPreparerSegment(tx, data);
    const history = await preparerHistory(tx, data);
    if (history.some((row) => row.id === `question_preparer_finished_${jobId}`)) return null;
    const started = history.some((row) => row.id === `question_preparer_started_unknown_${jobId}`);
    const registered = history
      .filter((row) => row.outcome === 'run_registered' && row.payload.job_id === jobId)
      .flatMap((row) => (typeof row.payload.run_id === 'string' ? [row.payload.run_id] : []));
    const runIds = [
      ...new Set([...registered, ...(started ? [`question_preparer_${jobId}`] : [])]),
    ];
    const publications = await readTaskRunPublications(tx, `question_preparer_${jobId}`);
    let interruptedUnknown = started && registered.length === 0;
    if (runIds.length) {
      const rows = await tx.select().from(ai_task_runs).where(inArray(ai_task_runs.id, runIds));
      interruptedUnknown ||= rows.length !== runIds.length;
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
      submittedCount: publications.length,
      interruptedUnknown,
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
    return bindQuestionPreparerDelivery(tx, {
      jobId: supplyDeliveryJobId(`question_preparer_recovery:${jobId}`),
      data: { ...data, recovery: { prior_job_id: jobId } },
    });
  });
  if (successor) await drainQuestionPreparerDeliveries(db, boss, { jobId: successor });
}

export function buildQuestionPreparerRecoveryHandler(db: Db) {
  return async () => {
    await drainQuestionPreparerDeliveries(db, await getStartedBoss());
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
