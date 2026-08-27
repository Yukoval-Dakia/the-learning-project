import { createId } from '@paralleldrive/cuid2';
import { inArray } from 'drizzle-orm';
import {
  COPILOT_EVIDENCE_COMPARISON_ALLOWED_TOOLS,
  COPILOT_EVIDENCE_MAX_TRACE_CALLS,
  COPILOT_EVIDENCE_REFERENCE_ALLOWED_TOOLS,
  COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME,
} from '@/core/copilot-evidence';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import {
  AgentRunError,
  isProviderSessionWallClockBudgetError,
  isTransientAgentFailure,
} from '@/server/ai/agent-run-error';
import { resolveModelProfileByModel } from '@/server/ai/model-profiles';
import { type TaskTextResult, taskPromptFingerprint } from '@/server/ai/provenance';
import { resolveTaskProvider } from '@/server/ai/providers';
import { type RunTaskCtx, runTask } from '@/server/ai/runner';
import {
  persistValidatorRunBinding,
  runConfirmedStructuredReview,
} from '@/server/ai/sealed-validation';
import type { ToolExecutionResultObservation } from '@/server/ai/tools/mcp-bridge';
import {
  type CopilotEvidenceCheckpoint,
  type CopilotEvidenceCheckpointBinding,
  type CopilotEvidenceCheckpointStore,
  comparisonResumeInputBlock,
  createInMemoryCopilotEvidenceCheckpointStore,
  referenceResumeInputBlock,
  rehydrateCopilotEvidenceSubmission,
} from './evidence-checkpoint';
import { createPgCopilotEvidenceCheckpointStore } from './evidence-checkpoint-pg';
import {
  type BoundCopilotEvidenceComparison,
  type BoundCopilotEvidenceReference,
  segmentEvidenceReply,
  segmentEvidenceRequest,
} from './evidence-contract';
import {
  type ComparisonEvidenceSubmission,
  type ReferenceEvidenceSubmission,
  buildCopilotEvidenceSourceCatalog,
  createComparisonEvidenceSubmission,
  createReferenceEvidenceSubmission,
  projectCopilotEvidenceModelTrace,
  sourceCatalogDigest,
} from './evidence-submission';

export const COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY =
  '这轮证据审阅未能完成，现有结果无法裁决。为避免把推测当成事实，我无法安全复述本轮结论；已执行的工具动作记录不会因此回滚，请在对应页面核对后重试。';
export const COPILOT_EVIDENCE_REVIEW_LOW_CONFIDENCE_ANNOTATION =
  '提示：本轮证据复核因时间限制未完成；以下内容来自已完成的证据整理，置信度较低，请在对应页面核对。';

/** Mirrors both inline evidence-task timeout budgets in the task registry. */
export const COPILOT_EVIDENCE_REVIEW_TIMEOUT_MS = 120_000;
/**
 * Complex durable traces can legitimately need more than the synchronous tail.
 * Actual A01 on 4708378a reached 31 accepted points, six classified calls, and
 * the safe reply at 360s but had not completed the final seal/terminal turns.
 */
export const COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS = 480_000;
/**
 * Actual A01 on c8bd8761 hit 120s on both independent comparators; 3ad1f0f9
 * then hit 240s on the first comparator. Keep inline at 120s and align only
 * this durable tail with the proven blind budget. Attempts/binding stay fixed.
 */
export const COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS = 360_000;
export const COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS = 2;
export const COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS = 2;
export const COPILOT_EVIDENCE_CHECKPOINT_RETRY_MAX_ATTEMPTS = 2;
const COPILOT_EVIDENCE_COMPARISON_MAX_PAID_CALLS =
  COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS + COPILOT_EVIDENCE_CHECKPOINT_RETRY_MAX_ATTEMPTS - 1;
export const COPILOT_EVIDENCE_REVIEW_MAX_PASSES =
  COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS +
  COPILOT_EVIDENCE_COMPARISON_MAX_PAID_CALLS +
  COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS;
export const COPILOT_DURABLE_EVIDENCE_REVIEW_TOTAL_TIMEOUT_MS =
  COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS * COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS +
  COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS *
    (COPILOT_EVIDENCE_COMPARISON_MAX_PAID_CALLS + COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS);

/** Per-model durable leg budgets handed to `attemptTimeouts` (YUK-839 ruling ①b). */
export interface CopilotDurableEvidenceAttemptTimeouts {
  readonly referenceMs: number;
  readonly comparisonMs: number;
}

/**
 * The only model with a non-default durable tier today (zhipu GLM coding-plan
 * lane). Kept as the documented label for the YUK-839 burn-in evidence; the
 * tier itself is now selected through the ModelProfile registry (YUK-924):
 * the zhipu provider binding declares `execution.timeoutClass:
 * 'durable-heavy'` for exactly this model id.
 */
export const COPILOT_DURABLE_EVIDENCE_FLASH_MODEL_ID = 'glm-5.3-flash';

/**
 * YUK-839 owner ruling ①b (2026-08-27) — relax the durable budgets FOR THAT MODEL.
 * Burn-in R2 (docs/planning/2026-08-26-yuk-839-burnin-glm53flash.md) measured
 * zhipu/glm-5.3-flash on the A01-equivalent 77KB fixture: reference leg 771.9s
 * (~13min; Round 1 lost 4/4 attempts to the 480s budget with zero accepted
 * appends — a pure budget/latency mismatch, not an endpoint or tooling defect),
 * comparators 168.9s / 339.3s, full reference + double-comparator flow 21.3min.
 * Flash tier = observed leg max with ~1.5x headroom: reference 1_200_000ms
 * (20min ≈ 1.55 × 771.9s), comparison 600_000ms (10min ≈ 1.77 × 339.3s).
 * mimo/default keeps the constants below EXACTLY (they are sized from mimo
 * A01 traces — see their own doc comments).
 *
 * Scope: leg budgets only. The outer recovery envelope
 * (COPILOT_DURABLE_EVIDENCE_REVIEW_TOTAL_TIMEOUT_MS →
 * DURABLE_OWNER_SETTLEMENT_BUDGET_MS, which must stay < the 1h
 * STUCK_RUN_THRESHOLD_MS sweeper fence) deliberately keeps its mimo sizing:
 * the observed 21.3min flash flow fits inside it, and scaling the worst-case
 * attempt sum (2×1200s + 5×600s = 90min) past 1h would require re-fencing the
 * stuck-run sweeper — a cross-cutting recovery change outside this ruling. A
 * flash run that legitimately exceeds the envelope degrades along the
 * pre-existing ambiguous-terminal path and never duplicates paid work.
 */
const COPILOT_DURABLE_EVIDENCE_DEFAULT_TIMEOUTS: CopilotDurableEvidenceAttemptTimeouts =
  Object.freeze({
    referenceMs: COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS,
    comparisonMs: COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS,
  });

const COPILOT_DURABLE_EVIDENCE_FLASH_TIMEOUTS: CopilotDurableEvidenceAttemptTimeouts =
  Object.freeze({
    referenceMs: 1_200_000,
    comparisonMs: 600_000,
  });

/** ModelProfile timeout class → concrete durable leg budgets (YUK-924 site 1). */
const COPILOT_DURABLE_EVIDENCE_TIMEOUTS_BY_CLASS: Readonly<
  Record<'standard' | 'durable-heavy', CopilotDurableEvidenceAttemptTimeouts>
> = Object.freeze({
  standard: COPILOT_DURABLE_EVIDENCE_DEFAULT_TIMEOUTS,
  'durable-heavy': COPILOT_DURABLE_EVIDENCE_FLASH_TIMEOUTS,
});

/** Unknown/undefined models (every mimo lane included) keep the default tier. */
export function durableEvidenceTimeoutsFor(
  model: string | undefined,
): CopilotDurableEvidenceAttemptTimeouts {
  if (model === undefined) return COPILOT_DURABLE_EVIDENCE_DEFAULT_TIMEOUTS;
  return COPILOT_DURABLE_EVIDENCE_TIMEOUTS_BY_CLASS[
    resolveModelProfileByModel(model).execution.timeoutClass
  ];
}

/**
 * Best-effort model the durable validator legs will run on. The paid legs go
 * through runTask with no ctx.override, so their lane is exactly
 * `resolveTaskProvider(<evidence kind>)`: the AI_PROVIDER_OVERRIDE /
 * AI_PROVIDER_MODEL env switch, else the registry default
 * (xiaomi/mimo-v2.5-pro — both evidence task kinds share it, so resolving the
 * reference kind yields every leg's model). Resolution failures (missing
 * provider credentials, invalid env override) degrade to undefined → default
 * tier: the identical failure surfaces at paid-call time inside the FULL gate's
 * fail-closed handling, so budget selection must never throw here.
 */
export function durableEvidenceLaneModel(): string | undefined {
  try {
    return resolveTaskProvider('CopilotEvidenceReviewTask').model;
  } catch {
    return undefined;
  }
}

const MAX_CANDIDATE_CHARS = 64_000;
const MAX_SERIALIZED_TRACE_CHARS = 160_000;
const MAX_SERIALIZED_REVIEW_INPUT_CHARS = 320_000;

export interface CopilotEvidenceReviewRunResult extends TaskTextResult {
  task_run_id?: string;
}

export type CopilotEvidenceReviewRunTaskFn = (
  kind: 'CopilotEvidenceReviewTask' | 'CopilotEvidenceVerificationTask',
  input: unknown,
  ctx: RunTaskCtx,
  submission: ReferenceEvidenceSubmission | ComparisonEvidenceSubmission,
) => Promise<CopilotEvidenceReviewRunResult>;

export interface CopilotEvidenceReviewDecision {
  status: 'skipped' | 'pass' | 'repair' | 'degraded' | 'failed_closed';
  replyText: string;
  /** Compatibility alias for the final successful blind-reference run. */
  reviewTaskRunId?: string;
  /** Compatibility alias for the final successful comparator run. */
  verificationTaskRunId?: string;
  referenceTaskRunIds?: string[];
  comparisonTaskRunIds?: string[];
  violations?: string[];
}

async function defaultRunTaskFn(
  kind: 'CopilotEvidenceReviewTask' | 'CopilotEvidenceVerificationTask',
  input: unknown,
  ctx: RunTaskCtx,
): Promise<CopilotEvidenceReviewRunResult> {
  return runTask(kind, input, ctx);
}

function failClosed(
  reason: string,
  candidateTaskRunId: string,
  audit: Pick<CopilotEvidenceReviewDecision, 'referenceTaskRunIds' | 'comparisonTaskRunIds'> = {},
): CopilotEvidenceReviewDecision {
  console.warn('[copilot-evidence-review] fail closed', {
    event: 'copilot_evidence_review_fail_closed',
    candidate_task_run_id: candidateTaskRunId,
    reason,
  });
  return {
    status: 'failed_closed',
    replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
    ...audit,
  };
}

function ensureSerializableBounded(value: unknown, label: string): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label}_not_serializable`);
  }
  if (serialized.length > MAX_SERIALIZED_REVIEW_INPUT_CHARS) {
    throw new Error(`${label}_too_large`);
  }
  return serialized;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function paidTaskFailureKind(error: unknown): string {
  if (error instanceof AgentRunError) return error.subtype;
  // run-lifecycle.ts deliberately throws a plain Error when the provider
  // session wall-clock budget elapses before a retry can start; classify it as
  // the budget exhaustion it is so the degradation predicate sees the retry
  // the same way as an in-flight budget_timeout kill.
  if (isProviderSessionWallClockBudgetError(error)) return 'budget_timeout';
  return error instanceof Error ? error.name : 'unknown';
}

function proposalContractRepair(
  toolTrace: readonly ToolExecutionResultObservation[],
): string | undefined {
  const proposalCalls = toolTrace.filter((entry) => entry.proposal_effect_contract !== undefined);
  if (proposalCalls.length === 0) return undefined;
  const proposalIsPending = (entry: ToolExecutionResultObservation): boolean => {
    const output =
      entry.output !== null && typeof entry.output === 'object' && !Array.isArray(entry.output)
        ? (entry.output as Record<string, unknown>)
        : undefined;
    const status = typeof output?.status === 'string' ? output.status : undefined;
    return (
      entry.executed &&
      entry.error_reason === null &&
      status !== undefined &&
      status !== 'failed' &&
      !status.startsWith('skipped:')
    );
  };

  const callResults = proposalCalls.map((entry) => {
    const output =
      entry.output !== null && typeof entry.output === 'object' && !Array.isArray(entry.output)
        ? (entry.output as Record<string, unknown>)
        : undefined;
    const status = typeof output?.status === 'string' ? output.status : undefined;
    const proposalId = typeof output?.proposal_id === 'string' ? output.proposal_id : undefined;
    const result = [
      status ? `status=${status}` : undefined,
      proposalId ? `proposal_id=${proposalId}` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(', ');
    const retainedDraft = entry.proposal_effect_contract?.retained_draft;
    const retainedDraftResult = retainedDraft
      ? `retained draft=${retainedDraft.kind} (written before accept, irreversible, retained after dismiss)`
      : undefined;
    const details = [result || undefined, retainedDraftResult]
      .filter((value): value is string => value !== undefined)
      .join('; ');
    return [
      `- \`${entry.name}\`${details ? `: ${details}` : ''}`,
      ...(proposalIsPending(entry) ? [] : ['  未执行目标变更；未产生待 owner 接受的 proposal。']),
    ].join('\n');
  });
  const hasPendingProposal = proposalCalls.some(proposalIsPending);

  return [
    '本轮 proposal 结果由服务端契约裁定：',
    ...callResults,
    '- owner gate: FULL',
    '- direct target write: false',
    '- pre-accept rollback: dismiss_before_accept',
    hasPendingProposal
      ? '任何目标变更都尚未直接写入；只有 owner 接受对应 proposal 后才会应用。'
      : '本轮没有可接受的 proposal，未执行任何目标变更。',
  ].join('\n');
}

async function bindRunResult(params: {
  db: Db;
  kind: 'CopilotEvidenceReviewTask' | 'CopilotEvidenceVerificationTask';
  taskInputSha256: string;
  taskRunId: string;
  resultDigest: string | null;
}): Promise<void> {
  // Lightweight routing tests intentionally pass a DB-less structural stub.
  // Production Db always exposes update(), so every paid run is bound there.
  if (typeof (params.db as { update?: unknown }).update !== 'function') return;
  await persistValidatorRunBinding(params.db, {
    taskRunId: params.taskRunId,
    taskKind: params.kind,
    taskInputSha256: params.taskInputSha256,
    promptFingerprint: taskPromptFingerprint(params.kind),
    resultDigest: params.resultDigest,
  });
}

async function beforePaidCall(params: {
  signal?: AbortSignal;
  beforeVerification?: () => Promise<void>;
}): Promise<void> {
  params.signal?.throwIfAborted();
  await params.beforeVerification?.();
  params.signal?.throwIfAborted();
}

async function attachCheckpoint(
  store: CopilotEvidenceCheckpointStore,
  binding: CopilotEvidenceCheckpointBinding,
  submission: ReferenceEvidenceSubmission | ComparisonEvidenceSubmission,
) {
  const checkpoint = await store.load(binding);
  if (checkpoint) {
    const rehydrated = rehydrateCopilotEvidenceSubmission(submission, checkpoint.records);
    if (!rehydrated.ok) throw new Error(`checkpoint_rehydrate_failed:${rehydrated.reason}`);
  }
  submission.setAppendListener((record) => store.appendRecords(binding, [record]));
  return checkpoint;
}

async function successfulCheckpointTaskRun(
  db: Db,
  checkpoint: CopilotEvidenceCheckpoint,
): Promise<{ taskRunId: string; taskInputSha256: string } | undefined> {
  const recordedSuccess = checkpoint.attempts.findLast((attempt) => attempt.outcome === 'success');
  if (recordedSuccess) {
    return {
      taskRunId: recordedSuccess.task_run_id,
      taskInputSha256: recordedSuccess.task_input_sha256,
    };
  }
  const runningAttempts = checkpoint.attempts.filter((attempt) => attempt.outcome === 'running');
  const runningIds = runningAttempts.map((attempt) => attempt.task_run_id);
  if (runningIds.length === 0 || typeof (db as { select?: unknown }).select !== 'function') {
    return undefined;
  }
  const rows = await db
    .select({ id: ai_task_runs.id, status: ai_task_runs.status })
    .from(ai_task_runs)
    .where(inArray(ai_task_runs.id, runningIds));
  const successfulRow = rows.find((row) => row.status === 'success');
  const successfulAttempt = runningAttempts.find(
    (attempt) => attempt.task_run_id === successfulRow?.id,
  );
  return successfulAttempt
    ? {
        taskRunId: successfulAttempt.task_run_id,
        taskInputSha256: successfulAttempt.task_input_sha256,
      }
    : undefined;
}

function checkpointFailureOutcome(error: unknown): 'failed_retryable' | 'failed_permanent' {
  return isTransientAgentFailure(error) ? 'failed_retryable' : 'failed_permanent';
}

async function runBlindReference(params: {
  db: Db;
  recoveryScopeId: string;
  requestContext: unknown;
  requestUnits: ReturnType<typeof segmentEvidenceRequest>;
  sourceComplete: boolean;
  toolTrace: readonly ToolExecutionResultObservation[];
  signal?: AbortSignal;
  beforeVerification?: () => Promise<void>;
  attemptTimeoutMs?: number;
  providerSessionDeadlineAt?: number;
  runTaskFn: CopilotEvidenceReviewRunTaskFn;
  checkpointStore: CopilotEvidenceCheckpointStore;
}): Promise<
  | { ok: true; reference: BoundCopilotEvidenceReference; taskRunIds: string[] }
  | { ok: false; reason: string; taskRunIds: string[] }
> {
  const sourceCatalog = buildCopilotEvidenceSourceCatalog(params.toolTrace);
  const evidenceTrace = projectCopilotEvidenceModelTrace(params.toolTrace, sourceCatalog);
  const baseTaskInput = {
    protocol_version: 1,
    request_context: params.requestContext,
    request_units: params.requestUnits,
    source_complete: params.sourceComplete,
    evidence_trace: evidenceTrace,
  };
  const sourceCatalogSha256 = sourceCatalogDigest(sourceCatalog);
  const referenceTaskInput = {
    ...baseTaskInput,
    submission_protocol: {
      kind: 'append_only_tools',
      source_catalog_sha256: sourceCatalogSha256,
      max_evidence_points_per_call: 12,
      max_not_material_calls_per_call: 12,
      server_derives: ['point_indices', 'request_coverage', 'trace_coverage', 'json_pointers'],
    },
  };
  const checkpointBinding: CopilotEvidenceCheckpointBinding = {
    task_kind: 'CopilotEvidenceReviewTask',
    slot: 'reference',
    protocol_version: 1,
    prompt_fingerprint: taskPromptFingerprint('CopilotEvidenceReviewTask'),
    base_input_sha256: sha256CanonicalJson(referenceTaskInput),
    source_catalog_sha256: sourceCatalogSha256,
    binding_extras: {
      recovery_scope_id: params.recoveryScopeId,
      source_complete: String(params.sourceComplete),
    },
  };
  ensureSerializableBounded(referenceTaskInput, 'reference_input');
  const taskRunIds: string[] = [];
  let lastDetail = '';
  let contractFeedback: string | undefined;

  for (let attempt = 1; attempt <= COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS; attempt += 1) {
    const submission = createReferenceEvidenceSubmission({
      requestUnits: params.requestUnits,
      toolTrace: params.toolTrace,
      sourceCatalog,
    });
    const checkpoint = await attachCheckpoint(
      params.checkpointStore,
      checkpointBinding,
      submission,
    );
    const recoveredReference = submission.completedReference();
    if (checkpoint?.status === 'sealed' && checkpoint.sealed && recoveredReference) {
      const verified = await params.checkpointStore.verifySealedRun(
        checkpointBinding,
        checkpoint.sealed,
      );
      if (!verified || checkpoint.sealed.digest_sha256 !== recoveredReference.digest_sha256) {
        return { ok: false, reason: 'reference_checkpoint_seal_mismatch', taskRunIds };
      }
      return {
        ok: true,
        reference: recoveredReference,
        taskRunIds: checkpoint.attempts.map((item) => item.task_run_id),
      };
    }
    if (checkpoint?.status === 'open' && recoveredReference) {
      const successfulTaskRun = await successfulCheckpointTaskRun(params.db, checkpoint);
      if (successfulTaskRun) {
        await bindRunResult({
          db: params.db,
          kind: 'CopilotEvidenceReviewTask',
          taskInputSha256: successfulTaskRun.taskInputSha256,
          taskRunId: successfulTaskRun.taskRunId,
          resultDigest: recoveredReference.digest_sha256,
        });
        const sealed = {
          output_json: recoveredReference.output,
          digest_sha256: recoveredReference.digest_sha256,
          task_run_id: successfulTaskRun.taskRunId,
        };
        const sealResult = await params.checkpointStore.markSealed(checkpointBinding, sealed);
        if (sealResult.status !== 'ok') {
          return { ok: false, reason: 'reference_checkpoint_seal_conflict', taskRunIds };
        }
        return {
          ok: true,
          reference: recoveredReference,
          taskRunIds: checkpoint.attempts.map((item) => item.task_run_id),
        };
      }
    }
    const resumeState = submission.resumeState();
    const taskInput = {
      ...referenceTaskInput,
      ...(resumeState.evidence_point_count > 0 ||
      resumeState.not_material_call_indices.length > 0 ||
      resumeState.safe_reply_set
        ? { checkpoint_resume: referenceResumeInputBlock(resumeState) }
        : {}),
      ...(contractFeedback
        ? {
            contract_feedback: {
              previous_attempt: attempt - 1,
              rejection: contractFeedback,
            },
          }
        : {}),
    };
    ensureSerializableBounded(taskInput, 'reference_input');
    const taskInputSha256 = sha256CanonicalJson(taskInput);
    try {
      await beforePaidCall(params);
    } catch (error) {
      if (params.signal?.aborted || isAbortError(error)) throw error;
      return {
        ok: false,
        reason: `reference_preflight_failed:${error instanceof Error ? error.name : 'unknown'}`,
        taskRunIds,
      };
    }
    const paidTaskRunId = createId();
    await params.checkpointStore.recordAttempt(checkpointBinding, {
      outcome: 'running',
      task_run_id: paidTaskRunId,
      task_input_sha256: taskInputSha256,
      started_at: new Date().toISOString(),
    });
    let result: CopilotEvidenceReviewRunResult;
    try {
      result = await params.runTaskFn(
        'CopilotEvidenceReviewTask',
        taskInput,
        {
          db: params.db,
          taskRunId: paidTaskRunId,
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.attemptTimeoutMs !== undefined
            ? { budgetOverride: { timeoutMs: params.attemptTimeoutMs } }
            : {}),
          ...(params.providerSessionDeadlineAt !== undefined
            ? { providerSessionDeadlineAt: params.providerSessionDeadlineAt }
            : {}),
          mcpServers: { [COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME]: submission.mcpServer },
          allowedTools: [...COPILOT_EVIDENCE_REFERENCE_ALLOWED_TOOLS],
          autoLogToolCalls: false,
        },
        submission,
      );
    } catch (error) {
      // Only an abort observed on the caller-owned signal is authoritative
      // cancellation. Provider/SDK timeouts may also surface as AbortError;
      // those are paid-attempt failures and must stay inside the FULL gate.
      if (params.signal?.aborted) throw error;
      const failedTaskRunId = error instanceof AgentRunError ? error.taskRunId : paidTaskRunId;
      if (!taskRunIds.includes(failedTaskRunId)) {
        taskRunIds.push(failedTaskRunId);
      }
      await submission.flushAppendListener();
      await params.checkpointStore.recordAttempt(checkpointBinding, {
        outcome: checkpointFailureOutcome(error),
        failure_kind: paidTaskFailureKind(error),
        task_run_id: failedTaskRunId,
        task_input_sha256: taskInputSha256,
        finished_at: new Date().toISOString(),
      });
      const progress = submission.progress();
      const failureKind = paidTaskFailureKind(error);
      lastDetail =
        `reference_task_failed:${failureKind}` +
        `:points=${progress.evidence_point_count}` +
        `:not_material=${progress.not_material_call_count}` +
        `:safe_reply=${Number(progress.safe_reply_set)}` +
        `:completed=${Number(progress.completed)}`;
      console.warn('[copilot-evidence-review] blind reference task failed', {
        attempt,
        failure_kind: failureKind,
        progress,
      });
      continue;
    }
    await submission.flushAppendListener();
    if (!result.task_run_id) {
      lastDetail = 'reference_task_run_id_missing';
      continue;
    }
    taskRunIds.push(result.task_run_id);

    const reference = submission.completedReference();
    if (!reference) {
      const completion = submission.completeReference();
      const detail = completion.ok ? 'submission_completion_missing' : completion.reason;
      lastDetail = `reference_output_invalid:${detail}`;
      contractFeedback = detail.slice(0, 240);
      console.warn('[copilot-evidence-review] blind reference contract rejected', {
        attempt,
        issues: detail,
      });
      try {
        await bindRunResult({
          db: params.db,
          kind: 'CopilotEvidenceReviewTask',
          taskInputSha256,
          taskRunId: result.task_run_id,
          resultDigest: null,
        });
        await params.checkpointStore.recordAttempt(checkpointBinding, {
          outcome: 'success',
          failure_kind: 'contract_invalid',
          task_run_id: result.task_run_id,
          task_input_sha256: taskInputSha256,
          finished_at: new Date().toISOString(),
        });
      } catch (bindingError) {
        return {
          ok: false,
          reason: `reference_binding_failed:${bindingError instanceof Error ? bindingError.name : 'unknown'}`,
          taskRunIds,
        };
      }
      continue;
    }

    try {
      await params.checkpointStore.recordAttempt(checkpointBinding, {
        outcome: 'success',
        task_run_id: result.task_run_id,
        task_input_sha256: taskInputSha256,
        finished_at: new Date().toISOString(),
      });
      await bindRunResult({
        db: params.db,
        kind: 'CopilotEvidenceReviewTask',
        taskInputSha256,
        taskRunId: result.task_run_id,
        resultDigest: reference.digest_sha256,
      });
      const sealed = {
        output_json: reference.output,
        digest_sha256: reference.digest_sha256,
        task_run_id: result.task_run_id,
      };
      const sealResult = await params.checkpointStore.markSealed(checkpointBinding, sealed);
      if (sealResult.status !== 'ok') throw new Error('reference_checkpoint_seal_conflict');
    } catch (error) {
      return {
        ok: false,
        reason: `reference_binding_failed:${error instanceof Error ? error.name : 'unknown'}`,
        taskRunIds,
      };
    }
    return { ok: true, reference, taskRunIds };
  }
  return {
    ok: false,
    reason: lastDetail || 'reference_attempt_budget_exhausted',
    taskRunIds,
  };
}

async function runConfirmedComparison(params: {
  db: Db;
  recoveryScopeId: string;
  requestUnits: ReturnType<typeof segmentEvidenceRequest>;
  selectedReply: string;
  selectedTextKind: 'original' | 'blind_reference';
  sourceComplete: boolean;
  reference: BoundCopilotEvidenceReference;
  toolTrace: readonly ToolExecutionResultObservation[];
  signal?: AbortSignal;
  beforeVerification?: () => Promise<void>;
  attemptTimeoutMs?: number;
  providerSessionDeadlineAt?: number;
  runTaskFn: CopilotEvidenceReviewRunTaskFn;
  checkpointStore: CopilotEvidenceCheckpointStore;
  checkpointRetryBudget: { remaining: number };
}): Promise<
  | {
      status: 'decided';
      verdict: 'pass' | 'fail';
      comparison: BoundCopilotEvidenceComparison;
      taskRunIds: string[];
      hasNonTimeoutNegativeAttempt: boolean;
    }
  | { status: 'invalid'; reason: string; taskRunIds: string[] }
> {
  const replyUnits = segmentEvidenceReply(params.selectedReply);
  const selectedReplySha256 = sha256CanonicalJson({ text: params.selectedReply });
  const sourceCatalog = buildCopilotEvidenceSourceCatalog(params.toolTrace);
  const baseTaskInput = {
    protocol_version: 1,
    request_units: params.requestUnits,
    reply_units: replyUnits,
    selected_reply_sha256: selectedReplySha256,
    selected_text_kind: params.selectedTextKind,
    source_complete: params.sourceComplete,
    sealed_reference: {
      digest_sha256: params.reference.digest_sha256,
      evidence_points: params.reference.output.evidence_points,
      request_coverage: params.reference.output.request_coverage,
      trace_coverage: params.reference.output.trace_coverage,
    },
    evidence_trace: projectCopilotEvidenceModelTrace(params.toolTrace, sourceCatalog),
    submission_protocol: {
      kind: 'append_only_tools',
      max_reply_checks_per_call: 12,
      server_derives: ['request_checks', 'verdict', 'result_digest'],
    },
  };
  ensureSerializableBounded(baseTaskInput, 'comparison_input');
  const sourceCatalogSha256 = sourceCatalogDigest(sourceCatalog);
  const allTaskRunIds: string[] = [];
  const allFailureDetails: string[] = [];

  const result = await runConfirmedStructuredReview<BoundCopilotEvidenceComparison>({
    maxAttempts: COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS,
    runAttempt: async (pass) => {
      const paidAttemptLimit = 1 + params.checkpointRetryBudget.remaining;
      const checkpointBinding: CopilotEvidenceCheckpointBinding = {
        task_kind: 'CopilotEvidenceVerificationTask',
        slot: `comparison:${params.selectedTextKind}:pass_${pass}`,
        protocol_version: 1,
        prompt_fingerprint: taskPromptFingerprint('CopilotEvidenceVerificationTask'),
        base_input_sha256: sha256CanonicalJson(baseTaskInput),
        source_catalog_sha256: sourceCatalogSha256,
        binding_extras: {
          recovery_scope_id: params.recoveryScopeId,
          reference_digest_sha256: params.reference.digest_sha256,
          selected_reply_sha256: selectedReplySha256,
        },
      };
      for (let paidAttempt = 1; paidAttempt <= paidAttemptLimit; paidAttempt += 1) {
        const submission = createComparisonEvidenceSubmission({
          requestUnits: params.requestUnits,
          replyUnits,
          selectedReply: params.selectedReply,
          reference: params.reference,
          toolTrace: params.toolTrace,
          sourceComplete: params.sourceComplete,
        });
        const checkpoint = await attachCheckpoint(
          params.checkpointStore,
          checkpointBinding,
          submission,
        );
        const recoveredComparison = submission.completedComparison();
        if (checkpoint?.status === 'sealed' && checkpoint.sealed && recoveredComparison) {
          const verified = await params.checkpointStore.verifySealedRun(
            checkpointBinding,
            checkpoint.sealed,
          );
          if (!verified || checkpoint.sealed.digest_sha256 !== recoveredComparison.digest_sha256) {
            return { outcome: 'contract_invalid', detail: 'comparison_checkpoint_seal_mismatch' };
          }
          allTaskRunIds.push(checkpoint.sealed.task_run_id);
          return {
            outcome: 'valid',
            task_run_id: checkpoint.sealed.task_run_id,
            verdict: recoveredComparison.verdict,
            result: recoveredComparison,
          };
        }
        if (checkpoint?.status === 'open' && recoveredComparison) {
          const successfulTaskRun = await successfulCheckpointTaskRun(params.db, checkpoint);
          if (successfulTaskRun) {
            await bindRunResult({
              db: params.db,
              kind: 'CopilotEvidenceVerificationTask',
              taskInputSha256: successfulTaskRun.taskInputSha256,
              taskRunId: successfulTaskRun.taskRunId,
              resultDigest: recoveredComparison.digest_sha256,
            });
            const sealed = {
              output_json: recoveredComparison.output,
              digest_sha256: recoveredComparison.digest_sha256,
              task_run_id: successfulTaskRun.taskRunId,
            };
            const sealResult = await params.checkpointStore.markSealed(checkpointBinding, sealed);
            if (sealResult.status !== 'ok') {
              return { outcome: 'contract_invalid', detail: 'comparison_checkpoint_seal_conflict' };
            }
            allTaskRunIds.push(successfulTaskRun.taskRunId);
            return {
              outcome: 'valid',
              task_run_id: successfulTaskRun.taskRunId,
              verdict: recoveredComparison.verdict,
              result: recoveredComparison,
            };
          }
        }
        const resumeState = submission.resumeState();
        const taskInput = {
          ...baseTaskInput,
          confirmation_pass: pass,
          ...(resumeState.reply_check_unit_indices.length > 0
            ? { checkpoint_resume: comparisonResumeInputBlock(resumeState) }
            : {}),
        };
        ensureSerializableBounded(taskInput, 'comparison_input');
        const taskInputSha256 = sha256CanonicalJson(taskInput);
        try {
          await beforePaidCall(params);
        } catch (error) {
          if (params.signal?.aborted || isAbortError(error)) throw error;
          return {
            outcome: 'contract_invalid',
            detail: `comparison_preflight_failed:${error instanceof Error ? error.name : 'unknown'}`,
          };
        }
        const paidTaskRunId = createId();
        await params.checkpointStore.recordAttempt(checkpointBinding, {
          outcome: 'running',
          task_run_id: paidTaskRunId,
          task_input_sha256: taskInputSha256,
          started_at: new Date().toISOString(),
        });
        let taskResult: CopilotEvidenceReviewRunResult;
        try {
          taskResult = await params.runTaskFn(
            'CopilotEvidenceVerificationTask',
            taskInput,
            {
              db: params.db,
              taskRunId: paidTaskRunId,
              ...(params.signal ? { signal: params.signal } : {}),
              ...(params.attemptTimeoutMs !== undefined
                ? { budgetOverride: { timeoutMs: params.attemptTimeoutMs } }
                : {}),
              ...(params.providerSessionDeadlineAt !== undefined
                ? { providerSessionDeadlineAt: params.providerSessionDeadlineAt }
                : {}),
              mcpServers: { [COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME]: submission.mcpServer },
              allowedTools: [...COPILOT_EVIDENCE_COMPARISON_ALLOWED_TOOLS],
              autoLogToolCalls: false,
            },
            submission,
          );
        } catch (error) {
          if (params.signal?.aborted) throw error;
          await submission.flushAppendListener();
          const progress = submission.progress();
          const failureKind = paidTaskFailureKind(error);
          const detail =
            `comparison_task_failed:${failureKind}` +
            `:reply_checks=${progress.reply_check_count}` +
            `:completed=${Number(progress.completed)}`;
          allFailureDetails.push(detail);
          console.warn('[copilot-evidence-review] comparator task failed', {
            pass,
            paid_attempt: paidAttempt,
            failure_kind: failureKind,
            progress,
          });
          const failedTaskRunId = error instanceof AgentRunError ? error.taskRunId : paidTaskRunId;
          allTaskRunIds.push(failedTaskRunId);
          await params.checkpointStore.recordAttempt(checkpointBinding, {
            outcome: checkpointFailureOutcome(error),
            failure_kind: failureKind,
            task_run_id: failedTaskRunId,
            task_input_sha256: taskInputSha256,
            finished_at: new Date().toISOString(),
          });
          if (
            failureKind === 'budget_timeout' &&
            params.checkpointRetryBudget.remaining > 0 &&
            paidAttempt < paidAttemptLimit
          ) {
            params.checkpointRetryBudget.remaining -= 1;
            continue;
          }
          return {
            outcome: 'contract_invalid',
            ...(error instanceof AgentRunError ? { task_run_id: error.taskRunId } : {}),
            detail,
          };
        }
        await submission.flushAppendListener();
        if (!taskResult.task_run_id) {
          return { outcome: 'contract_invalid', detail: 'comparison_task_run_id_missing' };
        }
        allTaskRunIds.push(taskResult.task_run_id);
        const comparison = submission.completedComparison();
        if (!comparison) {
          const completion = submission.completeComparison();
          const detail = completion.ok ? 'submission_completion_missing' : completion.reason;
          allFailureDetails.push(detail);
          console.warn('[copilot-evidence-review] comparator contract rejected', {
            pass,
            paid_attempt: paidAttempt,
            issues: detail,
          });
          try {
            await bindRunResult({
              db: params.db,
              kind: 'CopilotEvidenceVerificationTask',
              taskInputSha256,
              taskRunId: taskResult.task_run_id,
              resultDigest: null,
            });
            await params.checkpointStore.recordAttempt(checkpointBinding, {
              outcome: 'success',
              failure_kind: 'contract_invalid',
              task_run_id: taskResult.task_run_id,
              task_input_sha256: taskInputSha256,
              finished_at: new Date().toISOString(),
            });
          } catch (bindingError) {
            return {
              outcome: 'contract_invalid',
              task_run_id: taskResult.task_run_id,
              detail: `comparison_binding_failed:${bindingError instanceof Error ? bindingError.name : 'unknown'}`,
            };
          }
          return { outcome: 'contract_invalid', task_run_id: taskResult.task_run_id, detail };
        }
        try {
          await params.checkpointStore.recordAttempt(checkpointBinding, {
            outcome: 'success',
            task_run_id: taskResult.task_run_id,
            task_input_sha256: taskInputSha256,
            finished_at: new Date().toISOString(),
          });
          await bindRunResult({
            db: params.db,
            kind: 'CopilotEvidenceVerificationTask',
            taskInputSha256,
            taskRunId: taskResult.task_run_id,
            resultDigest: comparison.digest_sha256,
          });
          const sealed = {
            output_json: comparison.output,
            digest_sha256: comparison.digest_sha256,
            task_run_id: taskResult.task_run_id,
          };
          const sealResult = await params.checkpointStore.markSealed(checkpointBinding, sealed);
          if (sealResult.status !== 'ok') throw new Error('comparison_checkpoint_seal_conflict');
        } catch (bindingError) {
          return {
            outcome: 'contract_invalid',
            task_run_id: taskResult.task_run_id,
            detail: `comparison_binding_failed:${bindingError instanceof Error ? bindingError.name : 'unknown'}`,
          };
        }
        return {
          outcome: 'valid',
          task_run_id: taskResult.task_run_id,
          verdict: comparison.verdict,
          result: comparison,
        };
      }
      return { outcome: 'contract_invalid', detail: 'comparison_checkpoint_retry_exhausted' };
    },
  });
  const taskRunIds = Array.from(new Set(allTaskRunIds));
  const invalidAttempts = result.attempts.filter(
    (attempt) => attempt.outcome === 'contract_invalid',
  );
  const hasNonTimeoutNegativeAttempt =
    result.attempts.some(
      (attempt) =>
        (attempt.outcome === 'contract_invalid' &&
          !attempt.detail?.startsWith('comparison_task_failed:budget_timeout')) ||
        (attempt.outcome === 'valid' && attempt.verdict === 'fail'),
    ) ||
    allFailureDetails.some((detail) => !detail.startsWith('comparison_task_failed:budget_timeout'));
  if (result.status === 'invalid') {
    const budgetTimedOut =
      invalidAttempts.length > 0 &&
      invalidAttempts.every((attempt) =>
        attempt.detail?.startsWith('comparison_task_failed:budget_timeout'),
      );
    return {
      status: 'invalid',
      reason: budgetTimedOut ? 'comparison_budget_timeout' : result.reason,
      taskRunIds,
    };
  }
  return {
    status: 'decided',
    verdict: result.verdict,
    comparison: result.result,
    taskRunIds,
    hasNonTimeoutNegativeAttempt,
  };
}

export async function reviewCopilotEvidenceReply(params: {
  db: Db;
  requestContext: unknown;
  candidateReply: string;
  candidateTaskRunId: string;
  candidateComplete?: boolean;
  toolTrace: readonly ToolExecutionResultObservation[];
  signal?: AbortSignal;
  /** Optional durable-truth probe before every paid validation call. */
  beforeVerification?: () => Promise<void>;
  /** Internal per-leg wall-clock overrides; omitted callers retain registry budgets. */
  attemptTimeouts?: { referenceMs?: number; comparisonMs?: number };
  /** One absolute HTTP request budget reused by every inline validation attempt. */
  providerSessionDeadlineAt?: number;
  runTaskFn?: CopilotEvidenceReviewRunTaskFn;
  checkpointStore?: CopilotEvidenceCheckpointStore;
}): Promise<CopilotEvidenceReviewDecision> {
  if (!params.toolTrace.some((entry) => entry.effect === 'read')) {
    const repairedReply = proposalContractRepair(params.toolTrace);
    if (repairedReply) {
      return {
        status: 'repair',
        replyText: repairedReply,
        violations: ['proposal_only_reply_server_normalized'],
      };
    }
    return { status: 'skipped', replyText: params.candidateReply };
  }
  if (params.candidateReply.length > MAX_CANDIDATE_CHARS) {
    return failClosed('candidate_too_large', params.candidateTaskRunId);
  }
  if (params.toolTrace.length > COPILOT_EVIDENCE_MAX_TRACE_CALLS) {
    return failClosed('trace_call_count_exceeds_contract', params.candidateTaskRunId);
  }

  let serializedTrace: string;
  try {
    serializedTrace = JSON.stringify(params.toolTrace);
  } catch {
    return failClosed('trace_not_serializable', params.candidateTaskRunId);
  }
  if (serializedTrace.length > MAX_SERIALIZED_TRACE_CHARS) {
    return failClosed('trace_too_large', params.candidateTaskRunId);
  }

  const run = params.runTaskFn ?? defaultRunTaskFn;
  const checkpointStore =
    params.checkpointStore ??
    (typeof (params.db as { transaction?: unknown }).transaction === 'function'
      ? createPgCopilotEvidenceCheckpointStore(params.db)
      : createInMemoryCopilotEvidenceCheckpointStore());
  try {
    await checkpointStore.cleanupExpired();
  } catch (error) {
    return failClosed(
      `checkpoint_cleanup_failed:${error instanceof Error ? error.name : 'unknown'}`,
      params.candidateTaskRunId,
    );
  }
  const sourceComplete = params.candidateComplete ?? true;
  let requestUnits: ReturnType<typeof segmentEvidenceRequest>;
  try {
    requestUnits = segmentEvidenceRequest(params.requestContext);
  } catch (error) {
    return failClosed(
      `request_units_invalid:${error instanceof Error ? error.message : 'unknown'}`,
      params.candidateTaskRunId,
    );
  }

  params.signal?.throwIfAborted();
  let reference: Awaited<ReturnType<typeof runBlindReference>>;
  try {
    reference = await runBlindReference({
      db: params.db,
      recoveryScopeId: params.candidateTaskRunId,
      requestContext: params.requestContext,
      requestUnits,
      sourceComplete,
      toolTrace: params.toolTrace,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.beforeVerification ? { beforeVerification: params.beforeVerification } : {}),
      ...(params.attemptTimeouts?.referenceMs !== undefined
        ? { attemptTimeoutMs: params.attemptTimeouts.referenceMs }
        : {}),
      ...(params.providerSessionDeadlineAt !== undefined
        ? { providerSessionDeadlineAt: params.providerSessionDeadlineAt }
        : {}),
      runTaskFn: run,
      checkpointStore,
    });
  } catch (error) {
    if (params.signal?.aborted || isAbortError(error)) throw error;
    return failClosed(
      `reference_setup_failed:${error instanceof Error ? error.name : 'unknown'}`,
      params.candidateTaskRunId,
    );
  }
  // Degradation policy: a blind-review failure fails closed; after blind-review success,
  // only comparator budget timeouts may degrade. Any deterministic non-timeout denial,
  // whether contract-invalid or a valid fail verdict, keeps the result fail-closed.
  if (!reference.ok) {
    return failClosed(reference.reason, params.candidateTaskRunId, {
      referenceTaskRunIds: reference.taskRunIds,
    });
  }
  const degradeWithBlindReply = (comparisonTaskRunIds: string[]): CopilotEvidenceReviewDecision => {
    const reviewTaskRunId = reference.taskRunIds.at(-1);
    const contractRepair = proposalContractRepair(params.toolTrace);
    const blindReadFacts = contractRepair
      ? (reference.reference.output.safe_reply.match(/[^；。！？\n]+[；。！？\n]?/gu) ?? [])
          .filter(
            (clause) =>
              !/\bLIGHT\b|无需\s*owner|(?:已|已经|直接).{0,16}(?:归档|写入|执行|应用|删除|合并|重挂|改挂|创建|生成)|(?:relearn.{0,16}(?:回滚|恢复)|(?:回滚|恢复).{0,16}relearn)/iu.test(
                clause,
              ),
          )
          .join('')
          .trim()
      : reference.reference.output.safe_reply;
    console.warn('[copilot-evidence-review] verification degraded', {
      event: 'copilot_evidence_review_verification_timeout_degraded',
      candidate_task_run_id: params.candidateTaskRunId,
      reference_task_run_ids: reference.taskRunIds,
      comparison_task_run_ids: comparisonTaskRunIds,
    });
    return {
      status: 'degraded',
      replyText: [
        COPILOT_EVIDENCE_REVIEW_LOW_CONFIDENCE_ANNOTATION,
        blindReadFacts || undefined,
        contractRepair,
      ]
        .filter((section): section is string => section !== undefined)
        .join('\n\n'),
      referenceTaskRunIds: reference.taskRunIds,
      comparisonTaskRunIds,
      ...(reviewTaskRunId ? { reviewTaskRunId } : {}),
    };
  };
  const checkpointRetryBudget = {
    remaining: COPILOT_EVIDENCE_CHECKPOINT_RETRY_MAX_ATTEMPTS - 1,
  };

  let original: Awaited<ReturnType<typeof runConfirmedComparison>>;
  try {
    original = await runConfirmedComparison({
      db: params.db,
      recoveryScopeId: params.candidateTaskRunId,
      requestUnits,
      selectedReply: params.candidateReply,
      selectedTextKind: 'original',
      sourceComplete,
      reference: reference.reference,
      toolTrace: params.toolTrace,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.beforeVerification ? { beforeVerification: params.beforeVerification } : {}),
      ...(params.attemptTimeouts?.comparisonMs !== undefined
        ? { attemptTimeoutMs: params.attemptTimeouts.comparisonMs }
        : {}),
      ...(params.providerSessionDeadlineAt !== undefined
        ? { providerSessionDeadlineAt: params.providerSessionDeadlineAt }
        : {}),
      runTaskFn: run,
      checkpointStore,
      checkpointRetryBudget,
    });
  } catch (error) {
    if (params.signal?.aborted || isAbortError(error)) throw error;
    return failClosed(
      `original_comparison_failed:${error instanceof Error ? error.message : 'unknown'}`,
      params.candidateTaskRunId,
      { referenceTaskRunIds: reference.taskRunIds },
    );
  }
  if (original.status === 'invalid') {
    if (original.reason === 'comparison_budget_timeout') {
      return degradeWithBlindReply(original.taskRunIds);
    }
    return failClosed(`original_comparison_${original.reason}`, params.candidateTaskRunId, {
      referenceTaskRunIds: reference.taskRunIds,
      comparisonTaskRunIds: original.taskRunIds,
    });
  }
  if (original.verdict === 'pass') {
    const verificationTaskRunId = original.taskRunIds.at(-1);
    const reviewTaskRunId = reference.taskRunIds.at(-1);
    return {
      status: 'pass',
      replyText: params.candidateReply,
      referenceTaskRunIds: reference.taskRunIds,
      comparisonTaskRunIds: original.taskRunIds,
      ...(reviewTaskRunId ? { reviewTaskRunId } : {}),
      ...(verificationTaskRunId ? { verificationTaskRunId } : {}),
    };
  }

  const fallbackReply = reference.reference.output.safe_reply;
  if (fallbackReply.length > MAX_CANDIDATE_CHARS) {
    return failClosed('reference_reply_too_large', params.candidateTaskRunId, {
      referenceTaskRunIds: reference.taskRunIds,
      comparisonTaskRunIds: original.taskRunIds,
    });
  }
  let fallback: Awaited<ReturnType<typeof runConfirmedComparison>>;
  try {
    fallback = await runConfirmedComparison({
      db: params.db,
      recoveryScopeId: params.candidateTaskRunId,
      requestUnits,
      selectedReply: fallbackReply,
      selectedTextKind: 'blind_reference',
      sourceComplete,
      reference: reference.reference,
      toolTrace: params.toolTrace,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.beforeVerification ? { beforeVerification: params.beforeVerification } : {}),
      ...(params.attemptTimeouts?.comparisonMs !== undefined
        ? { attemptTimeoutMs: params.attemptTimeouts.comparisonMs }
        : {}),
      ...(params.providerSessionDeadlineAt !== undefined
        ? { providerSessionDeadlineAt: params.providerSessionDeadlineAt }
        : {}),
      runTaskFn: run,
      checkpointStore,
      checkpointRetryBudget,
    });
  } catch (error) {
    if (params.signal?.aborted || isAbortError(error)) throw error;
    return failClosed(
      `fallback_comparison_failed:${error instanceof Error ? error.message : 'unknown'}`,
      params.candidateTaskRunId,
      {
        referenceTaskRunIds: reference.taskRunIds,
        comparisonTaskRunIds: original.taskRunIds,
      },
    );
  }
  if (
    fallback.status === 'invalid' &&
    fallback.reason === 'comparison_budget_timeout' &&
    !original.hasNonTimeoutNegativeAttempt
  ) {
    return degradeWithBlindReply([...original.taskRunIds, ...fallback.taskRunIds]);
  }
  if (fallback.status !== 'decided' || fallback.verdict !== 'pass') {
    const reason =
      fallback.status === 'invalid'
        ? `fallback_comparison_${fallback.reason}`
        : 'fallback_comparison_rejected';
    return failClosed(reason, params.candidateTaskRunId, {
      referenceTaskRunIds: reference.taskRunIds,
      comparisonTaskRunIds: [...original.taskRunIds, ...fallback.taskRunIds],
    });
  }

  const comparisonTaskRunIds = [...original.taskRunIds, ...fallback.taskRunIds];
  const reviewTaskRunId = reference.taskRunIds.at(-1);
  const verificationTaskRunId = fallback.taskRunIds.at(-1);
  return {
    status: 'repair',
    replyText: fallbackReply,
    violations: original.comparison.violations,
    referenceTaskRunIds: reference.taskRunIds,
    comparisonTaskRunIds,
    ...(reviewTaskRunId ? { reviewTaskRunId } : {}),
    ...(verificationTaskRunId ? { verificationTaskRunId } : {}),
  };
}
