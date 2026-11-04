import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { piDomainMount } from '@/ai/pi-tool-mount';
import { getConfig } from '@/core/config/store';
import type { Db } from '@/db/client';
import { event, tool_call_log } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { lockQuestionSubmitRequest } from '@/kernel/locks/question-supply';
import { EvidenceDemandV1 } from '@/kernel/supply-contracts';
import { QUESTION_PREPARER_TOOLS, resolveMcpAllowedTools } from '@/kernel/tools/allowlists';
import { runAgentTask } from '@/server/ai/runner';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  admitNightlySourcingRun,
  holdNightlySupplyUnit,
  settleNightlySourcingRun,
} from './spend-gate';

export const AdmissionRepairReturn = z.object({
  question_id: z.string().min(1),
  revision_id: z.string().min(1),
  repair_target: z.enum(['question_text', 'scoring_structure', 'reference_answer', 'figure']),
  broken_part: z.enum(['question', 'options', 'figure', 'scoring_unit', 'reference']),
  defect: z.string().min(1),
  fix_hint_md: z.string().min(1),
  suggested_key: z.json().optional(),
  evidence_errors: z.array(
    z.object({
      which: z.enum(['source_answer', 'printed_rule', 'author_key']),
      note: z.string(),
    }),
  ),
});
export const QuestionPreparerJobData = z.object({
  ticket: EvidenceDemandV1,
  steering: z.array(z.json()).optional(),
  continuation: z
    .object({
      prior_job_id: z.string().min(1),
      verdict: AdmissionRepairReturn,
      simulated: z.boolean().default(false),
    })
    .optional(),
});
const terminalSchema = z.object({
  ticket: EvidenceDemandV1,
  task_run_id: z.string(),
  outcome: z.enum(['done', 'no_progress', 'awaiting_admission']),
  summary: z.string(),
});
const action = 'experimental:question_preparer';

/** One job segment of the same gap task. A claimed but unfinished segment is never paid twice. */
export async function runQuestionPreparer(db: Db, jobId: string, raw: unknown) {
  const data = QuestionPreparerJobData.parse(raw);
  const taskRunId = `question_preparer_${jobId}`;
  const operationKey = data.continuation
    ? `repair:${data.continuation.prior_job_id}:${data.continuation.verdict.revision_id}`
    : `ticket:${data.ticket.demand_id}`;
  const claimId = `question_preparer_claim_${createHash('sha256').update(operationKey).digest('hex')}`;
  let priorContext: unknown = null;
  if (data.continuation) {
    const [prior] = await db
      .select()
      .from(event)
      .where(eq(event.id, `question_preparer_done_${data.continuation.prior_job_id}`))
      .limit(1);
    const previous = terminalSchema.parse(prior?.payload);
    if (
      previous.ticket.demand_id !== data.ticket.demand_id ||
      JSON.stringify(previous.ticket) !== JSON.stringify(data.ticket)
    ) {
      throw new Error('repair continuation must retain the original gap ticket');
    }
    const calls = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.task_run_id, previous.task_run_id))
      .orderBy(tool_call_log.occurred_at);
    const verdict = data.continuation.verdict;
    if (
      !calls.some(
        (call) =>
          call.tool_name.endsWith('submit_question') &&
          call.output_json?.question_id === verdict.question_id &&
          call.output_json?.revision_id === verdict.revision_id &&
          (call.output_json?.published === true ||
            call.output_json?.publish_status === 'published'),
      )
    ) {
      throw new Error(
        'repair verdict does not reference a published submission of the prior segment',
      );
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
  const claimed = await db.transaction(async (tx) => {
    await lockQuestionSubmitRequest(tx, `question_preparer:${operationKey}`);
    const [prior] = await tx
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, claimId))
      .limit(1);
    if (prior) return false;
    const now = new Date();
    await writeEvent(tx, {
      id: claimId,
      action,
      actor_kind: 'agent',
      actor_ref: 'question_preparer',
      subject_kind: 'query',
      subject_id: data.ticket.demand_id,
      outcome: 'started',
      payload: data,
      task_run_id: taskRunId,
      caused_by_event_id: null,
      cost_micro_usd: null,
      session_id: null,
      created_at: now,
      ingest_at: now,
    });
    return true;
  });
  if (!claimed) return { outcome: 'already_started', task_run_id: taskRunId };
  async function finish(outcome: z.infer<typeof terminalSchema>['outcome'], summary: string) {
    const terminal = { ticket: data.ticket, task_run_id: taskRunId, outcome, summary };
    const now = new Date();
    await writeEvent(db, {
      id: `question_preparer_done_${jobId}`,
      action,
      actor_kind: 'agent',
      actor_ref: 'question_preparer',
      subject_kind: 'query',
      subject_id: data.ticket.demand_id,
      outcome,
      payload: terminal,
      task_run_id: taskRunId,
      caused_by_event_id: null,
      cost_micro_usd: null,
      session_id: null,
      created_at: now,
      ingest_at: now,
    });
    return terminal;
  }
  const spendKey = `question_preparer:${jobId}`;
  const hold = await holdNightlySupplyUnit(db, {
    targetId: spendKey,
    questionCount: data.ticket.inventory_goal.eligible_count,
  });
  if (!hold.granted) return finish('no_progress', 'unified_supply_spend_policy_denied');
  const cap = getConfig('SUPPLY_NIGHTLY_SPEND_CAP_USD');
  if (typeof cap !== 'number') throw new Error('Unreadable unified supply cost policy');
  const admission = await admitNightlySourcingRun(db, {
    targetId: spendKey,
    runCeilingMicroUsd: Math.round(cap * 1_000_000),
  });
  if (!admission.gated || admission.runCapMicroUsd <= 0) {
    await settleNightlySourcingRun(db, { targetId: spendKey, taskRunIds: [], submittedCount: 0 });
    return finish('no_progress', 'unified_supply_spend_policy_denied');
  }
  let noProgress = false;
  const publishedRevisions = new Set<string>();
  let inventorySatisfied = false;
  const nestedRunIds = new Set<string>();
  const seen = new Set<string>();
  let priorDefect: string | null = null;
  const input = {
    gap_ticket: data.ticket,
    steering: data.steering,
    admission_return: data.continuation?.verdict,
    admission_return_simulated: data.continuation?.simulated,
    prior_context: priorContext,
  };
  let result: Awaited<ReturnType<typeof runAgentTask>>;
  try {
    result = await runAgentTask('QuestionPreparerTask', input, {
      db,
      taskRunId,
      subjectProfile: resolveSubjectProfile(data.ticket.subject_id),
      allowedTools: [...resolveMcpAllowedTools('question_preparer')],
      budgetOverride: { maxIterations: 'unbounded', maxCost: admission.runCapMicroUsd / 1_000_000 },
      nativeCompaction: {
        sessionContext: JSON.stringify({
          gap_ticket: data.ticket,
          steering: data.steering,
          admission_return: data.continuation?.verdict,
          admission_return_simulated: data.continuation?.simulated,
        }),
      },
      piHooks: {
        beforeToolCall: [
          () =>
            noProgress
              ? {
                  block: true,
                  terminate: true,
                  reason: 'no_progress: repeated tool input and result',
                }
              : undefined,
        ],
      },
      piToolMounts: [
        piDomainMount({
          ctx: { db, taskRunId, callerActor: { kind: 'agent', ref: 'question_preparer' } },
          serverName: 'loom',
          toolNames: QUESTION_PREPARER_TOOLS,
          taskKind: 'QuestionPreparerTask',
          onResult(observation) {
            const issues = z
              .object({
                issues: z.array(z.object({ code: z.string(), detail: z.string() })).optional(),
              })
              .safeParse(observation.output);
            const defect =
              issues.success && issues.data.issues?.length
                ? JSON.stringify([observation.name, issues.data.issues])
                : null;
            if (defect !== null && defect === priorDefect) noProgress = true;
            priorDefect = defect;

            const fingerprint = createHash('sha256')
              .update(
                JSON.stringify([
                  observation.name,
                  observation.input,
                  observation.output,
                  observation.error_reason,
                ]),
              )
              .digest('hex');
            if (seen.has(fingerprint)) noProgress = true;
            seen.add(fingerprint);
            const output = z
              .object({
                published: z.boolean().optional(),
                publish_status: z.string().optional(),
                fulfillment: z.string().optional(),
                revision_id: z.string().optional(),
                task_run_id: z.string().nullable().optional(),
              })
              .safeParse(observation.output);
            if (
              observation.name === 'search_bank' &&
              output.success &&
              output.data.fulfillment === 'met'
            )
              inventorySatisfied = true;
            if (output.success && output.data.task_run_id)
              nestedRunIds.add(output.data.task_run_id);
            if (
              observation.name === 'submit_question' &&
              output.success &&
              (output.data.published || output.data.publish_status === 'published') &&
              output.data.revision_id
            )
              publishedRevisions.add(output.data.revision_id);
          },
        }),
      ],
    });
  } catch (error) {
    await finish(
      'no_progress',
      'execution_failed; consult the task-run cost and transport evidence before retrying',
    );
    throw error;
  } finally {
    await settleNightlySourcingRun(db, {
      targetId: spendKey,
      taskRunIds: [taskRunId, ...nestedRunIds],
      submittedCount: publishedRevisions.size,
    });
  }
  const report = z
    .object({ outcome: z.enum(['done', 'no_progress']), summary: z.string() })
    .safeParse(
      (() => {
        try {
          return JSON.parse(result.text);
        } catch {
          return null;
        }
      })(),
    );
  const outcome =
    noProgress || (report.success && report.data.outcome === 'no_progress')
      ? 'no_progress'
      : publishedRevisions.size > 0
        ? 'awaiting_admission'
        : inventorySatisfied
          ? 'done'
          : 'no_progress';
  return finish(outcome, report.success ? report.data.summary : result.text);
}
