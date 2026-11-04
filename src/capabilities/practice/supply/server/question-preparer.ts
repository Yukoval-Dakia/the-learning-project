import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createNoProgressLoop } from '@/ai/no-progress-loop';
import { piDomainMount } from '@/ai/pi-tool-mount';
import { getConfig } from '@/core/config/store';
import type { Db, Tx } from '@/db/client';
import { event, question_revision } from '@/db/schema';
import { parseTaskOutput } from '@/kernel/parse-task-output';
import { QUESTION_PREPARER_TOOLS, resolveMcpAllowedTools } from '@/kernel/tools/allowlists';
import { runAgentTask } from '@/server/ai/runner';
import { currentTaskSpendScope, withTaskSpendScope } from '@/server/ai/task-spend-scope';
import { getStartedBoss } from '@/server/boss/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import { QuestionPreparerJobData, preparerTerminal } from './question-preparer-contract';
import {
  defectCategory,
  lockQuestionPreparerSegment,
  preparerCalls,
  preparerFinish,
  preparerHistory,
  preparerRecord,
  preparerSpendKey,
  preparerSubmittedRevisions,
  preparerUnitContent,
  recoverQuestionPreparer,
} from './question-preparer-journal';
import {
  admitNightlySourcingRun,
  holdNightlySupplyUnit,
  priorSupplyRunCharge,
  settleNightlySourcingRun,
} from './spend-gate';

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            'search_id',
            'as_of',
            'expires_at',
            'cursor',
            'next_cursor',
            'result_digest',
            'request_id',
            'task_run_id',
            'task_run_ids',
            'cost_usd',
            'fetched_at',
          ].includes(key),
      )
      .map(([key, child]) => [key, stripVolatile(child)]),
  );
}

/** One admitted segment, with durable continuations on repair and interrupted delivery. */
export async function runQuestionPreparer(db: Db, jobId: string, raw: unknown, retryCount = 0) {
  let data = QuestionPreparerJobData.parse(raw);
  const taskRunId = `question_preparer_${jobId}`;
  const finish = (
    outcome: 'done' | 'no_progress' | 'awaiting_admission',
    summary: string,
    retryable = false,
  ) =>
    db.transaction(async (tx) => {
      await lockQuestionPreparerSegment(tx, data);
      const [existing] = await tx
        .select()
        .from(event)
        .where(eq(event.id, `question_preparer_finished_${jobId}`));
      return existing
        ? preparerTerminal.parse(existing.payload.terminal)
        : preparerFinish(tx, jobId, data, outcome, summary, retryable);
    });
  let history = await preparerHistory(db, data);
  if (history.some((row) => row.id === `question_preparer_unstarted_${jobId}`)) {
    const done = history.find((row) => row.id === `question_preparer_finished_${jobId}`);
    if (done) return preparerTerminal.parse(done.payload.terminal);
    if (retryCount > 0) await recoverQuestionPreparer(db, jobId, true);
    return { outcome: 'recovered_delivery', task_run_id: taskRunId };
  }
  if (!data.continuation && !data.recovery) {
    const retry = history
      .filter(
        (row) =>
          row.outcome === 'finished' &&
          row.payload.terminal &&
          preparerTerminal.parse(row.payload.terminal).retryable &&
          preparerTerminal.parse(row.payload.terminal).summary.startsWith('execution_failed'),
      )
      .at(-1);
    if (retry) data = { ...data, recovery: { prior_job_id: String(retry.payload.job_id) } };
  }
  const priorJobId = data.continuation?.prior_job_id ?? data.recovery?.prior_job_id;
  let priorContext: unknown = null;
  if (priorJobId) {
    const prior = history.find((row) => row.id === `question_preparer_finished_${priorJobId}`);
    // A verdict may beat recovery; finish that dead segment before binding its context.
    if (!prior) {
      await recoverQuestionPreparer(db, priorJobId);
      history = await preparerHistory(db, data);
    }
    const terminal = history.find((row) => row.id === `question_preparer_finished_${priorJobId}`);
    if (!terminal)
      throw new Error('prior preparer segment is still running or has no terminal record');
    const previous = preparerTerminal.parse(terminal.payload.terminal);
    if (JSON.stringify(previous.ticket) !== JSON.stringify(data.ticket))
      throw new Error('continuation must retain the original gap ticket');
    const calls = await preparerCalls(db, previous.task_run_id);
    const verdict = data.continuation?.verdict;
    if (verdict) {
      const authorRuns = history.filter(
        (row) => row.outcome === 'finished' && row.subject_id === data.ticket.demand_id,
      );
      const authorRunIds = authorRuns.map(
        (row) => preparerTerminal.parse(row.payload.terminal).task_run_id,
      );
      // Publication and its receipt share a transaction; tool logs do not.
      const authorReceipts = await Promise.all(
        authorRunIds.map((runId) => preparerSubmittedRevisions(db, runId)),
      );
      if (!authorReceipts.some((revisions) => revisions.has(verdict.revision_id)))
        throw new Error('repair verdict must bind a published submission of this ticket');
      const [revision] = await db
        .select()
        .from(question_revision)
        .where(
          and(
            eq(question_revision.group_id, verdict.question_id),
            eq(question_revision.revision_id, verdict.revision_id),
          ),
        );
      if (
        !revision?.scoring_basis.units.some(
          (unit) => unit.scoring_unit_id === verdict.scoring_unit_id,
        )
      )
        throw new Error('repair verdict must bind a unit in the submitted revision');
    }
    priorContext = {
      previous,
      calls: calls.map((call) => ({
        tool: call.tool_name,
        input: call.input_json,
        output: call.output_json,
        error: call.error_reason,
      })),
    };
  }
  // Short advisory-locked journal acts as the execution lease. Queue state, never age, releases it.
  const boss = await getStartedBoss();
  const claim = await db.transaction(async (tx) => {
    await lockQuestionPreparerSegment(tx, data);
    const records = await preparerHistory(tx, data);
    const returned = data.continuation?.verdict;
    const content = returned
      ? await preparerUnitContent(tx, returned.question_id, returned.scoring_unit_id)
      : null;
    if (returned && !content) {
      await preparerRecord(tx, jobId, data, 'unstarted');
      return {
        terminal: await preparerFinish(
          tx,
          jobId,
          data,
          'no_progress',
          'system_closed/unit_not_in_current_revision',
        ),
      };
    }
    const contentRecord = content
      ? { unit_content_digest: content.digest, unit_revision_id: content.revision_id }
      : {};
    let comparedLatestCategory = false;
    for (const row of records.filter((record) => record.outcome === 'unstarted').reverse()) {
      const previousId = String(row.payload.job_id);
      const terminal = records.find(
        (record) => record.id === `question_preparer_finished_${previousId}`,
      );
      if (!terminal) {
        const delivery = await boss.getJobById('question_preparer_run', previousId);
        if (!delivery || !['created', 'active', 'retry'].includes(delivery.state))
          return { recover: previousId };
        throw new Error('question preparer group has a live segment; retry delivery later');
      }
      const previous = QuestionPreparerJobData.parse(row.payload.data);
      const done = preparerTerminal.parse(terminal.payload.terminal);
      if (done.retryable) continue;
      if (
        !data.continuation &&
        !data.recovery &&
        previous.ticket.demand_id === data.ticket.demand_id
      )
        return { terminal: done };
      if (data.continuation && defectCategory(data) === defectCategory(previous)) {
        if (
          JSON.stringify(data.continuation.verdict) ===
            JSON.stringify(previous.continuation?.verdict) &&
          data.continuation.prior_job_id === previous.continuation?.prior_job_id
        )
          return { terminal: done };
        if (comparedLatestCategory) continue;
        comparedLatestCategory = true;
        const priorUnit = previous.continuation
          ? await preparerUnitContent(
              tx,
              previous.continuation.verdict.question_id,
              previous.continuation.verdict.scoring_unit_id,
              typeof row.payload.unit_revision_id === 'string'
                ? row.payload.unit_revision_id
                : previous.continuation.verdict.revision_id,
            )
          : null;
        if (!priorUnit) {
          await preparerRecord(tx, jobId, data, 'unstarted', contentRecord);
          return {
            terminal: await preparerFinish(
              tx,
              jobId,
              data,
              'no_progress',
              'system_closed/unit_content_unavailable',
            ),
          };
        }
        if (content?.digest !== priorUnit.digest) continue;
        await preparerRecord(tx, jobId, data, 'unstarted', contentRecord);
        const closed = await preparerFinish(
          tx,
          jobId,
          data,
          'no_progress',
          `system_closed/no_progress: unchanged defect for unit ${data.continuation.verdict.scoring_unit_id}`,
        );
        return { terminal: closed };
      }
    }
    await preparerRecord(tx, jobId, data, 'unstarted', contentRecord);
    return {};
  });
  if ('terminal' in claim) return claim.terminal;
  if (claim.recover) {
    await recoverQuestionPreparer(db, claim.recover);
    throw new Error('dead segment recovered; retry this delivery against its terminal context');
  }
  const cap = getConfig('SUPPLY_NIGHTLY_SPEND_CAP_USD');
  if (typeof cap !== 'number')
    return finish('no_progress', 'unreadable_unified_supply_policy', true);
  const previousSegments = (await preparerHistory(db, data))
    .filter(
      (row) =>
        row.outcome === 'unstarted' &&
        row.payload.job_id !== jobId &&
        row.subject_id === data.ticket.demand_id,
    )
    .map((row) => preparerSpendKey(String(row.payload.job_id)));
  const priorCharge = await priorSupplyRunCharge(db, previousSegments);
  const ticketRemaining =
    data.ticket.control.max_budget_micro_usd === null
      ? null
      : Math.max(0, data.ticket.control.max_budget_micro_usd - priorCharge);
  const allowance = Math.min(
    ticketRemaining ?? Math.round(cap * 1_000_000),
    Math.round(cap * 1_000_000),
  );
  if (allowance <= 0) return finish('no_progress', 'ticket_budget_exhausted');
  const spendKey = preparerSpendKey(jobId);
  const hold = await holdNightlySupplyUnit(db, {
    targetId: spendKey,
    questionCount: data.ticket.inventory_goal.eligible_count,
    runCeilingMicroUsd: allowance,
  });
  if (!hold.granted) return finish('no_progress', 'unified_supply_spend_policy_denied', true);
  const admission = await admitNightlySourcingRun(db, {
    targetId: spendKey,
    runCeilingMicroUsd: allowance,
  });
  if (!admission.gated || admission.runCapMicroUsd <= 0) {
    await settleNightlySourcingRun(db, { targetId: spendKey, taskRunIds: [], submittedCount: 0 });
    return finish('no_progress', 'unified_supply_spend_policy_denied', true);
  }
  async function assertSegmentOpen(tx?: Tx) {
    const connection = tx ?? db;
    if (tx) await lockQuestionPreparerSegment(tx, data);
    const [terminal] = await connection
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, `question_preparer_finished_${jobId}`));
    const job = await boss.getJobById('question_preparer_run', jobId);
    if (terminal || !job || job.state !== 'active')
      throw new Error('question preparer execution lease is no longer active');
  }
  const published = new Set<string>();
  const runIds = new Set<string>();
  const versions = new Set<string>();
  const progressRevisions = new Set<string>();
  const defects = new Set<string>();
  let inventorySatisfied = false;
  let bankEvidenceObserved = false;
  let pendingStockObserved = false;
  let started = false;
  const loop = createNoProgressLoop({
    normalize: stripVolatile,
    progressed(observation, payload) {
      const output = z
        .object({
          draft_ref: z.string().optional(),
          status: z.string().optional(),
          revision_id: z.string().optional(),
          published: z.boolean().optional(),
          publish_status: z.string().optional(),
          replayed: z.boolean().optional(),
          issues: z.array(z.object({ code: z.string(), detail: z.string() })).optional(),
        })
        .safeParse(
          payload && typeof payload === 'object' && 'output' in payload ? payload.output : payload,
        );
      if (!output.success || observation.isError) return false;
      const value = output.data;
      if (value.status === 'saved' && value.draft_ref && !versions.has(value.draft_ref)) {
        versions.add(value.draft_ref);
        return true;
      }
      if (
        (value.published || value.publish_status === 'published') &&
        !value.replayed &&
        value.revision_id &&
        !progressRevisions.has(value.revision_id)
      ) {
        progressRevisions.add(value.revision_id);
        return true;
      }
      if (value.issues?.length) {
        const identity = JSON.stringify(value.issues);
        if (!defects.has(identity)) {
          defects.add(identity);
          return true;
        }
      }
      return false;
    },
  });
  let result: Awaited<ReturnType<typeof runAgentTask>> | undefined;
  let executionError: unknown;
  try {
    result = await withTaskSpendScope(
      admission.runCapMicroUsd / 1_000_000,
      async (runId) => {
        if (runIds.has(runId)) return;
        await db.transaction(async (tx) => {
          await assertSegmentOpen(tx);
          if (!started) await preparerRecord(tx, jobId, data, 'started_unknown');
          await preparerRecord(tx, jobId, data, 'run_registered', {
            run_id: runId,
            remaining_micro_usd: Math.floor(
              (currentTaskSpendScope()?.remainingUsd() ?? 0) * 1_000_000,
            ),
          });
        });
        started = true;
        runIds.add(runId);
      },
      () =>
        runAgentTask(
          'QuestionPreparerTask',
          {
            gap_ticket: data.ticket,
            steering: data.steering,
            admission_return: data.continuation?.verdict,
            admission_return_simulated: data.continuation?.simulated,
            prior_context: priorContext,
            recovery_instruction: data.recovery
              ? 'Do not resend prior unknown paid requests; inspect persisted tool results and stock first.'
              : undefined,
          },
          {
            db,
            taskRunId,
            subjectProfile: resolveSubjectProfile(data.ticket.subject_id),
            allowedTools: [...resolveMcpAllowedTools('question_preparer')],
            judgeRetryPolicy: 'none',
            budgetOverride: {
              maxIterations: 'unbounded',
              maxCost: admission.runCapMicroUsd / 1_000_000,
            },
            nativeCompaction: { sessionContext: JSON.stringify(data) },
            piHooks: { beforeToolCall: [loop.beforeToolCall], afterToolCall: [loop.afterToolCall] },
            piToolMounts: [
              piDomainMount({
                ctx: {
                  db,
                  taskRunId,
                  callerActor: { kind: 'agent', ref: 'question_preparer' },
                  beforeIngestionWrite: assertSegmentOpen,
                },
                beforeExecute: async () => {
                  await assertSegmentOpen();
                  return undefined;
                },
                interceptInput(tool, args) {
                  if (args && typeof args === 'object' && !Array.isArray(args)) {
                    if (tool.name === 'scan_coverage_gaps')
                      return { args: { ...args, ticket: data.ticket } };
                    if (tool.name === 'submit_question')
                      return { args: { ...args, demand_id: data.ticket.demand_id } };
                  }
                  return { args };
                },
                serverName: 'loom',
                toolNames: QUESTION_PREPARER_TOOLS,
                taskKind: 'QuestionPreparerTask',
                onResult(observation) {
                  const value = z
                    .object({
                      published: z.boolean().optional(),
                      publish_status: z.string().optional(),
                      revision_id: z.string().optional(),
                      fulfillment: z.string().optional(),
                      replayed: z.boolean().optional(),
                      pending_stock: z.array(z.json()).optional(),
                    })
                    .safeParse(observation.output);
                  if (!value.success) return;
                  if (['search_bank', 'read_bank', 'check_bank'].includes(observation.name))
                    bankEvidenceObserved = true;
                  if (observation.name === 'scan_coverage_gaps' && value.data.pending_stock?.length)
                    pendingStockObserved = true;
                  if (observation.name === 'search_bank' && value.data.fulfillment === 'met')
                    inventorySatisfied = true;
                  if (
                    observation.name === 'submit_question' &&
                    value.data.revision_id &&
                    !value.data.replayed &&
                    (value.data.published || value.data.publish_status === 'published')
                  )
                    published.add(value.data.revision_id);
                },
              }),
            ],
          },
        ),
    );
  } catch (error) {
    executionError = error;
  } finally {
    for (const revision of await preparerSubmittedRevisions(db, taskRunId)) published.add(revision);
    await settleNightlySourcingRun(db, {
      targetId: spendKey,
      taskRunIds: [...runIds],
      submittedCount: published.size,
    });
  }
  if (!result)
    return finish(
      'no_progress',
      `execution_failed: ${executionError instanceof Error ? executionError.message : String(executionError)}`,
      true,
    );
  const report = z
    .object({ outcome: z.enum(['done', 'no_progress']), summary: z.string() })
    .safeParse(
      (() => {
        try {
          return parseTaskOutput(
            result.text,
            'QuestionPreparerTask',
            z.object({ outcome: z.enum(['done', 'no_progress']), summary: z.string() }),
          );
        } catch {
          return null;
        }
      })(),
    );
  return finish(
    published.size
      ? 'awaiting_admission'
      : inventorySatisfied
        ? 'done'
        : report.success && report.data.outcome === 'done' && bankEvidenceObserved
          ? pendingStockObserved
            ? 'awaiting_admission'
            : 'done'
          : 'no_progress',
    report.success ? report.data.summary : result.text,
  );
}
