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
import { readTaskRunPublications } from '@/kernel/records/publication-receipt';
import { unknownAttemptCostTruth } from '@/server/ai/attempt-cost';
import { writeAiTaskAttemptFinished } from '@/server/ai/log';
import { getStartedBoss } from '@/server/boss/client';
import {
  PREPARER_DISPATCH_ACTION,
  PREPARER_DISPATCH_INTENT_ACTION,
  type PreparerDispatchBoss,
  QUESTION_PREPARER_QUEUE,
  drainQuestionPreparerDispatch,
  parsePreparerDispatchIntent,
  writePreparerDispatchIntent,
} from './preparer-dispatch';
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

/** Queue truth proves a segment dead. Unknown requests are settled, never replayed.
 * The successor's delivery identity is bound inside the finishing transaction and sent
 * after commit by the shared drain — the only sender for this domain. Returns the
 * successor's bound delivery id when one was owed. */
export async function recoverQuestionPreparer(
  db: Db,
  jobId: string,
  forceDead = false,
): Promise<string | undefined> {
  const [claim] = await db
    .select()
    .from(event)
    .where(eq(event.id, `question_preparer_unstarted_${jobId}`));
  if (!claim) return undefined;
  const data = QuestionPreparerJobData.parse(claim.payload.data);
  const boss = (await getStartedBoss()) as PreparerDispatchBoss;
  const job = await boss.getJobById(QUESTION_PREPARER_QUEUE, jobId);
  if (!forceDead && job && ['created', 'retry', 'active'].includes(job.state)) return undefined;
  const successorJobId = await db.transaction(async (tx) => {
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
    // The successor obligation commits with the prior's finished row; the drain
    // delivers it under the bound id after this transaction.
    return writePreparerDispatchIntent(tx, {
      kind: 'recovery',
      data: { ...data, recovery: { prior_job_id: jobId } },
      send: { singleton_key: `question_preparer_recovery:${jobId}` },
    });
  });
  if (successorJobId) {
    await drainQuestionPreparerDispatch(db, boss, { jobId: successorJobId });
  }
  return successorJobId;
}

// A delivery the engine accepted but that died before its first journal row has no
// unstarted row for the old scan to claim, and its prior's finished row already blocks
// rescanning. The persisted intent carries the complete input, so the journal claims
// the segment post-hoc and runs the same recovery as a journaled death. Auto-recovery
// chains are bounded per demand: a successor that dies pre-journal still ends the line
// after a few generations instead of spamming forever on a deterministic fault.
const MAX_PREPARER_RECOVERY_GENERATIONS = 3;

async function recoverUnjournaledPreparerDeliveries(db: Db, boss: PreparerDispatchBoss) {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, PREPARER_DISPATCH_INTENT_ACTION),
        sql`EXISTS (SELECT 1 FROM event receipt WHERE receipt.action = ${PREPARER_DISPATCH_ACTION} AND receipt.payload->>'job_id' = ${event.payload}->>'job_id')`,
        sql`NOT EXISTS (SELECT 1 FROM event journal WHERE journal.id = 'question_preparer_unstarted_' || (${event.payload}->>'job_id'))`,
      ),
    )
    .orderBy(event.created_at, event.id)
    .limit(50);
  for (const row of rows) {
    const intent = parsePreparerDispatchIntent(row.payload);
    if (!intent) continue;
    const job = await boss.getJobById(QUESTION_PREPARER_QUEUE, intent.job_id);
    if (job && ['created', 'retry', 'active'].includes(job.state)) continue;
    // 'completed' is a true anomaly (the handler always journals first); 'cancelled'
    // was an operator act — neither is auto-recovered. A missing row, 'failed', or
    // 'expired' is the same dead-delivery class the claims scan already owns.
    if (job && (job.state === 'completed' || job.state === 'cancelled')) {
      console.error(
        `[question_preparer_journal] accepted delivery ${intent.job_id} is ${job.state} with no journal rows; leaving for the operator`,
      );
      continue;
    }
    const [{ generations }] = await db
      .select({ generations: sql<number>`count(*)::int` })
      .from(event)
      .where(
        and(
          eq(event.action, PREPARER_DISPATCH_INTENT_ACTION),
          eq(event.subject_id, intent.demand_id),
          sql`${event.payload}->'data'->'recovery' is not null`,
        ),
      );
    if (generations >= MAX_PREPARER_RECOVERY_GENERATIONS) {
      console.error(
        `[question_preparer_journal] delivery ${intent.job_id} for demand ${intent.demand_id} died pre-journal past ${MAX_PREPARER_RECOVERY_GENERATIONS} recovery generations; leaving for the operator`,
      );
      continue;
    }
    await preparerRecord(db, intent.job_id, intent.data, 'unstarted');
    await recoverQuestionPreparer(db, intent.job_id);
  }
}

export function buildQuestionPreparerRecoveryHandler(db: Db) {
  return async () => {
    const boss = (await getStartedBoss()) as PreparerDispatchBoss;
    // Owed deliveries go out first so the dead-segment probes below see fresh engine rows.
    await drainQuestionPreparerDispatch(db, boss);
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
    await recoverUnjournaledPreparerDeliveries(db, boss);
  };
}
