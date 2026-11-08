import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createNoProgressLoop } from '@/ai/no-progress-loop';
import { piDomainMount } from '@/ai/pi-tool-mount';
import { getConfig } from '@/core/config/store';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { parseTaskOutput } from '@/kernel/parse-task-output';
import {
  authorizeDemandRepair,
  readTaskRunPublications,
} from '@/kernel/records/publication-receipt';
import { QUESTION_PREPARER_TOOLS, resolveMcpAllowedTools } from '@/kernel/tools/allowlists';
import { runAgentTask } from '@/server/ai/runner';
import { currentTaskSpendScope, withTaskSpendScope } from '@/server/ai/task-spend-scope';
import { fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  BankAssessmentSchema,
  BankSearchError,
  selectBankReceipt,
} from '../../question-bank/public';
import { questionPreparerReportSchema } from '../tasks/question-preparer';
import { collectLearnerText, findLearnerCopy } from './preparer-learner-copy';
import {
  QuestionPreparerJobData,
  type preparerInventoryObservation,
  preparerTerminal,
} from './question-preparer-contract';
import {
  defectCategory,
  lockQuestionPreparerSegment,
  preparerCalls,
  preparerFinish,
  preparerHistory,
  preparerRecord,
  preparerSpendKey,
  preparerUnitContent,
  recoverQuestionPreparer,
} from './question-preparer-journal';
import { recoveryPriorContext } from './question-preparer-recovery';
import { questionPreparerPendingStock } from './question-preparer-stock';
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
  let inventoryReport: z.infer<typeof questionPreparerReportSchema>['inventory'];
  let inventoryObservation: z.infer<typeof preparerInventoryObservation> | undefined;
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
      if (existing) return preparerTerminal.parse(existing.payload.terminal);
      let finalOutcome = outcome,
        finalSummary = summary;
      if (outcome === 'done' && data.ticket.inventory_goal.eligible_count > 0) {
        let met = false;
        if (inventoryReport)
          try {
            const stock = await selectBankReceipt(
              tx,
              {
                callerActor: { kind: 'agent', ref: 'question_preparer' },
                taskRunId,
                supplyDemand: data.ticket,
              },
              inventoryReport.search_id,
              BankAssessmentSchema.array().parse(inventoryReport.assessments),
              true,
              true,
            );
            const count = new Set(stock.accepted_refs).size;
            inventoryObservation = {
              search_id: inventoryReport.search_id,
              source: stock.source,
              accepted_refs: stock.accepted_refs,
              count,
              goal: data.ticket.inventory_goal.eligible_count,
            };
            met =
              stock.use === 'inventory' &&
              stock.goal === data.ticket.inventory_goal.eligible_count &&
              count >= data.ticket.inventory_goal.eligible_count;
          } catch (error) {
            if (!(error instanceof BankSearchError) && !(error instanceof z.ZodError)) throw error;
          }
        if (!met) {
          const pending = await questionPreparerPendingStock(tx as unknown as Db, data.ticket);
          finalOutcome =
            (inventoryObservation?.count ?? 0) + pending.length >=
            data.ticket.inventory_goal.eligible_count
              ? 'awaiting_admission'
              : 'no_progress';
          finalSummary = '库存证据尚未确认满足票据目标；未知/不支持不计合格，待准入只作预留。';
        }
      }
      return preparerFinish(
        tx,
        jobId,
        data,
        finalOutcome,
        finalSummary,
        retryable,
        inventoryObservation,
      );
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
  const priorJobId = data.recovery?.prior_job_id ?? data.continuation?.prior_job_id;
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
    // A ticket-bound segment may never bind an unbound segment's tool log (it may hold
    // learner evidence); both sides must name the same durable ticket event.
    if ((previous.ticket_event_id ?? null) !== (data.ticket_event_id ?? null))
      throw new Error('continuation must retain the original ticket binding');
    const calls = await preparerCalls(db, previous.task_run_id);
    priorContext = recoveryPriorContext(previous, calls);
  }
  // Short advisory-locked journal acts as the execution lease. Queue state, never age, releases it.
  const boss = await getStartedBoss();
  const claim = await db.transaction(async (tx) => {
    await lockQuestionPreparerSegment(tx, data);
    const records = await preparerHistory(tx, data);
    const returned = data.continuation?.verdict;
    if (returned) {
      // Repair authorization reads the demand's committed publication receipts in the
      // same transaction that holds the ticket/question locks. Plain selects only: the
      // write path commits publication and its receipt together, so this read sees a
      // publication wholly or not at all.
      const decision = await authorizeDemandRepair(tx, data.ticket.demand_id, {
        question_id: returned.question_id,
        revision_id: returned.revision_id,
        scoring_unit_id: returned.scoring_unit_id,
      });
      if (decision.kind !== 'permitted')
        throw new Error(
          decision.reason === 'unit_not_in_revision'
            ? 'repair verdict must bind a unit in the submitted revision'
            : 'repair verdict must bind a published submission of this ticket',
        );
    }
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
        // Waiting is not a failed paid attempt: retain it beyond the queue's finite retries.
        await preparerRecord(tx, jobId, data, 'unstarted', contentRecord);
        const deferred = await preparerFinish(
          tx,
          jobId,
          data,
          'no_progress',
          `waiting_for_prior_segment:${previousId}`,
          true,
        );
        await boss.send('question_preparer_run', data, {
          db: fromPgBossDrizzleTx(tx),
          startAfter: new Date(Date.now() + 30_000),
          singletonKey: `question_preparer_wait:${jobId}`,
        });
        return { terminal: deferred };
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
  const defects = new Set<string>();
  let started = false;
  /** Set by onResult when the owner read found a publication this segment had not seen;
   *  consumed by the next afterToolCall (the submit that produced it). */
  let justPublished = false;
  const loop = createNoProgressLoop({
    normalize: stripVolatile,
    progressed(observation, payload) {
      // Publication progress comes from the owner read in onResult, not from the response.
      const publishedNow = justPublished;
      justPublished = false;
      if (observation.isError) return false;
      if (publishedNow) return true;
      const output = z
        .object({
          draft_ref: z.string().optional(),
          status: z.string().optional(),
          replayed: z.boolean().optional(),
          issues: z.array(z.object({ code: z.string(), detail: z.string() })).optional(),
        })
        .safeParse(
          payload && typeof payload === 'object' && 'output' in payload ? payload.output : payload,
        );
      if (!output.success) return false;
      const value = output.data;
      if (value.status === 'saved' && value.draft_ref && !versions.has(value.draft_ref)) {
        versions.add(value.draft_ref);
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
  const learnerText = new Set<string>();
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
            piHooks: { progress: loop },
            piToolMounts: [
              piDomainMount({
                ctx: {
                  db,
                  taskRunId,
                  callerActor: { kind: 'agent', ref: 'question_preparer' },
                  supplyDemand: data.ticket,
                  ...(data.ticket_event_id
                    ? {
                        causedByEventId: data.ticket_event_id,
                        publicationCausedByEventId: data.ticket_event_id,
                        ticketEventId: data.ticket_event_id,
                      }
                    : {}),
                  beforeIngestionWrite: assertSegmentOpen,
                },
                beforeExecute: async () => {
                  await assertSegmentOpen();
                  return undefined;
                },
                interceptInput(tool, args) {
                  if (tool.effect !== 'read') {
                    const copied = findLearnerCopy(args, learnerText);
                    if (copied)
                      return {
                        args,
                        softStop: `learner_text_copied: 草稿原样含有学习者错题材料「${copied}」。错题、笔记和错因分析只用来定方法和要防的错因类别，题面、选项、解答要自己写；改写后再保存。`,
                      };
                  }
                  if (args && typeof args === 'object' && !Array.isArray(args)) {
                    const record = args as Record<string, unknown>;
                    if (tool.name === 'scan_coverage_gaps')
                      return { args: { ...record, ticket: data.ticket } };
                    if (tool.name === 'submit_question')
                      return { args: { ...record, demand_id: data.ticket.demand_id } };
                  }
                  return { args };
                },
                serverName: 'loom',
                toolNames: QUESTION_PREPARER_TOOLS,
                taskKind: 'QuestionPreparerTask',
                onResult: async (observation) => {
                  if (observation.executed && observation.error_reason == null)
                    collectLearnerText(observation.name, observation.output, learnerText);
                  if (
                    observation.name === 'submit_question' &&
                    observation.executed &&
                    observation.error_reason == null
                  ) {
                    const before = published.size;
                    for (const receipt of await readTaskRunPublications(db, taskRunId))
                      published.add(receipt.revision_id);
                    if (published.size > before) justPublished = true;
                  }
                },
              }),
            ],
          },
        ),
    );
  } catch (error) {
    executionError = error;
  } finally {
    // The committed receipts, not the tool response, decide what this segment published.
    for (const receipt of await readTaskRunPublications(db, taskRunId))
      published.add(receipt.revision_id);
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
  const report = questionPreparerReportSchema.safeParse(
    (() => {
      try {
        return parseTaskOutput(result.text, 'QuestionPreparerTask', questionPreparerReportSchema);
      } catch {
        return null;
      }
    })(),
  );
  inventoryReport = report.success ? report.data.inventory : undefined;
  return finish(
    published.size
      ? 'awaiting_admission'
      : report.success && report.data.outcome === 'done'
        ? 'done'
        : 'no_progress',
    report.success
      ? report.data.summary
      : result.text || loop.closure()?.reason || 'no_terminal_report',
  );
}
