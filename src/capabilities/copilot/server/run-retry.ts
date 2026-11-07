import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event, job_events } from '@/db/schema';
import { shouldEnqueueBackgroundJobs } from '@/kernel/background-job-enqueue';
import { getCorrectionStatuses, writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { writeJobEvent } from '@/kernel/job-events';
import { checkRateLimit } from '@/kernel/request-rate-limit';
import type { ToolExecutionGateInput } from '@/kernel/tools/types';
import { parseCopilotPublicProse } from '../public-prose-contract';
import { isLiveCopilotConversation } from './conversation-lifecycle';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  isCopilotRunTerminalEvent,
} from './copilot-run-status';
import { copilotRunTerminalSql } from './copilot-run-terminal-sql';
import { MAX_OUTSTANDING_DURABLE_RUNS, countOutstandingDurableRuns } from './durable-backlog';
import {
  type CopilotBossTransactionAdapter,
  type CopilotDispatchBoss,
  acquireCopilotSessionQueueLock,
  copilotBossJobId,
  dispatchSessionHeadTx,
  parsePersistedJobData,
  readCopilotDurableAcceptanceByRunId,
} from './durable-dispatch';
import {
  COPILOT_RETRY_ACTION,
  COPILOT_RETRY_WRITE_STARTED,
  COPILOT_RUN_ROOT_ACTIONS,
} from './run-retry-contract';

export type CopilotRetryRefusal =
  | 'conversation_inactive'
  | 'question_retracted'
  | 'not_failed'
  | 'not_latest'
  | 'session_busy'
  | 'failure_not_retryable'
  | 'write_tool_started'
  | 'safety_unknown'
  | 'already_retried';

type Store = Db | Tx;

// These objects have learner-facing dismissal/undo. Steering remains available
// because dropping it would defeat explicit plan requests; its checkpoint is deferred.
const RETRY_WRITE_TOOLS = new Set([
  'propose_knowledge_edge',
  'propose_knowledge_mutation',
  'propose_learning_item_completion',
  'propose_learning_item_relearn',
  'propose_learning_item_defer',
  'propose_learning_item_archive',
  'propose_grading_correction',
  'edit_question',
  'remember_learner',
  'record_steering',
]);

/** Unknown effects and newly registered writes require an audited undo contract. */
export function retryToolDenial(tool: { name: string; effect?: ToolExecutionGateInput['effect'] }) {
  return tool.effect === 'read' ||
    (['propose', 'write', 'control'].includes(tool.effect ?? '') &&
      RETRY_WRITE_TOOLS.has(tool.name))
    ? undefined
    : '重发回合不能执行这个写入操作；请重新提出请求。';
}

async function runEvents(db: Store, runId: string) {
  return db
    .select()
    .from(job_events)
    .where(and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)))
    .orderBy(asc(job_events.id));
}

/** Same predicate for admission, refreshed turns and prospective terminal publication. */
export async function copilotRetryRefusal(
  db: Store,
  runId: string,
  options: {
    terminal?: { reason: string; public_prose?: unknown };
    lockConversation?: boolean;
  } = {},
): Promise<CopilotRetryRefusal | null> {
  const events = await runEvents(db, runId);
  const queued = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.QUEUED);
  const terminal = events.filter(isCopilotRunTerminalEvent).at(-1);
  const failure =
    options.terminal ??
    (terminal?.event_type === COPILOT_RUN_EVENTS.FAILED ? terminal.payload : undefined);
  if (!failure) return 'not_failed';
  const prose = parseCopilotPublicProse(failure.public_prose);
  if (
    !['connection', 'timeout', 'provider_error', 'rate_limited'].includes(
      prose?.failure?.kind ?? '',
    ) ||
    ['cancelled', 'ambiguous_execution', 'execution_unknown', 'finalization_failed'].includes(
      String(failure.reason),
    )
  )
    return 'failure_not_retryable';
  const sessionId = queued?.payload.session_id;
  if (typeof sessionId !== 'string') return 'safety_unknown';
  if (!(await isLiveCopilotConversation(db, sessionId, options.lockConversation)))
    return 'conversation_inactive';
  const [root] = await db.select().from(event).where(eq(event.id, runId));
  if (!root) return 'safety_unknown';
  const originalAskId =
    typeof root.payload.original_ask_id === 'string' ? root.payload.original_ask_id : runId;
  const corrections = await getCorrectionStatuses(db, [runId, originalAskId]);
  if ([runId, originalAskId].some((id) => corrections.get(id)?.state === 'retracted'))
    return 'question_retracted';
  const replacement = await db
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.action, COPILOT_RETRY_ACTION), eq(event.caused_by_event_id, runId)))
    .limit(1);
  if (replacement.length) return 'already_retried';
  const later = await db.execute(sql`SELECT id FROM event WHERE session_id = ${sessionId}
    AND action IN (${sql.join(
      COPILOT_RUN_ROOT_ACTIONS.map((a) => sql`${a}`),
      sql`, `,
    )})
    AND dispatch_seq > (SELECT dispatch_seq FROM event WHERE id = ${runId}) LIMIT 1`);
  if (later.length) return 'not_latest';
  const busy = await db.execute(sql`SELECT q.id FROM job_events q
    WHERE q.business_table = ${COPILOT_RUN_TABLE} AND q.event_type = ${COPILOT_RUN_EVENTS.QUEUED}
      AND q.payload->>'session_id' = ${sessionId} AND q.business_id <> ${runId}
      AND NOT EXISTS (SELECT 1 FROM job_events t WHERE t.business_table = q.business_table
        AND t.business_id = q.business_id AND ${copilotRunTerminalSql(sql.raw('t.event_type'), sql.raw('t.payload'))}) LIMIT 1`);
  if (busy.length) return 'session_busy';
  if (events.some((e) => e.event_type === COPILOT_RETRY_WRITE_STARTED)) return 'write_tool_started';
  const job = queued && parsePersistedJobData(queued.payload, runId, sessionId);
  // Skill and child execution have other tool gateways. Until those gateways carry
  // the same pre-execute evidence, absence of root-tool logs proves nothing.
  const children = await db.execute(
    sql`SELECT id FROM subagent_run WHERE parent_turn_event_id = ${runId} LIMIT 1`,
  );
  if (
    queued?.payload.retry_safety_version !== 1 ||
    !job ||
    job.skill_context ||
    job.confirmation ||
    root.payload.review_answer ||
    children.length
  )
    return 'safety_unknown';
  return null;
}

/** Commit before invoking the tool; failure to record this aborts execution. */
export async function recordRetryToolEffect(db: Db, runId: string, effect: unknown) {
  if (effect === 'read') return;
  await writeJobEvent(db, {
    business_table: COPILOT_RUN_TABLE,
    business_id: runId,
    event_type: COPILOT_RETRY_WRITE_STARTED,
    payload: { effect: typeof effect === 'string' ? effect : 'unknown' },
  });
}

/** Exclude replaced replies/progress before LIMIT, preserving original evidence. */
export function visibleCopilotReplySql() {
  return sql`NOT EXISTS (SELECT 1 FROM event retry_anchor
    WHERE retry_anchor.action = ${COPILOT_RETRY_ACTION}
      AND retry_anchor.caused_by_event_id = CASE WHEN ${event.action} = 'experimental:copilot_reply'
        THEN ${event.caused_by_event_id} ELSE ${event.id} END
      AND ${event.action} <> 'experimental:copilot_user_ask'
      AND ${event.action} <> 'experimental:copilot_chip_trigger')`;
}

/** A retry's current question must not also appear in its prompt history. */
export async function retryHistoryAnchor(db: Store, runId: string): Promise<string> {
  const [root] = await db.select({ payload: event.payload }).from(event).where(eq(event.id, runId));
  return typeof root?.payload.original_ask_id === 'string' ? root.payload.original_ask_id : runId;
}

export async function retryCopilotRun(
  db: Db,
  runId: string,
  key: string,
  deps: {
    boss: CopilotDispatchBoss;
    transactionDb: CopilotBossTransactionAdapter;
  },
) {
  const original = await readCopilotDurableAcceptanceByRunId(db, runId);
  if (!original) throw new ApiError('not_found', 'Run not found', 404);
  // Shared session lock serializes chat acceptance, dispatch and retry. Recheck
  // eligibility and insert the sole replacement under this lock in one transaction.
  // No settlement lock is needed: only an already committed terminal is eligible.
  return db.transaction(async (tx) => {
    await acquireCopilotSessionQueueLock(tx, original.sessionId);
    const [existing] = await tx
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.action, COPILOT_RETRY_ACTION), eq(event.caused_by_event_id, runId)))
      .limit(1);
    if (existing) {
      const replay = await readCopilotDurableAcceptanceByRunId(tx, existing.id);
      if (!replay) throw new Error('Retry acceptance integrity failure');
      return replay;
    }
    if (!shouldEnqueueBackgroundJobs())
      throw new ApiError('copilot_queue_disabled', 'Copilot queue is disabled', 503);
    const reason = await copilotRetryRefusal(tx, runId, { lockConversation: true });
    if (reason)
      throw new ApiError('retry_not_allowed', 'This run cannot be retried', 409, undefined, {
        reason,
      });
    // Replays do not consume admission capacity; each new generation does.
    if ((await countOutstandingDurableRuns(tx)) >= MAX_OUTSTANDING_DURABLE_RUNS) {
      throw new ApiError(
        'copilot_backlog_full',
        `Copilot backlog is full (max ${MAX_OUTSTANDING_DURABLE_RUNS})`,
        429,
        { 'Retry-After': '30' },
      );
    }
    checkRateLimit();
    const queued = (await runEvents(tx, runId)).find(
      (e) => e.event_type === COPILOT_RUN_EVENTS.QUEUED,
    );
    const job = queued && parsePersistedJobData(queued.payload, runId, original.sessionId);
    if (!queued || !job) throw new Error('Retry input integrity failure');
    // Identity depends on the failed run, so different keys from concurrent clicks
    // converge as well. Idempotency-Key is retained as request evidence only.
    const nextId = `copilot_retry_${createHash('sha256').update(runId).digest('hex')}`;
    const originalAskId = await retryHistoryAnchor(tx, runId);
    await writeEvent(tx, {
      id: nextId,
      session_id: original.sessionId,
      actor_kind: 'system',
      actor_ref: 'copilot:retry',
      action: COPILOT_RETRY_ACTION,
      subject_kind: 'query',
      subject_id: nextId,
      caused_by_event_id: runId,
      outcome: null,
      payload: {
        original_ask_id: originalAskId,
        retry_of: runId,
        derivation_policy: job.derivation_policy ?? 'allow',
      },
    });
    const bossJobId = copilotBossJobId(nextId);
    await writeJobEvent(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: nextId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: {
        ...queued.payload,
        run_id: nextId,
        boss_job_id: bossJobId,
        retry_of: runId,
        idempotency_key: key,
        job_data: { ...job, run_id: nextId },
      },
    });
    // Physical queue row, dispatch marker and replacement projection commit together.
    // A rollback preserves the failed turn; an unknown COMMIT is replayed by run id.
    await dispatchSessionHeadTx(tx, original.sessionId, deps.boss, deps.transactionDb, undefined);
    return { ...original, runId: nextId, bossJobId };
  });
}
