import {
  COPILOT_EVIDENCE_COMPARISON_ALLOWED_TOOLS,
  COPILOT_EVIDENCE_MAX_TRACE_CALLS,
  COPILOT_EVIDENCE_REFERENCE_ALLOWED_TOOLS,
  COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME,
} from '@/core/copilot-evidence';
import type { Db } from '@/db/client';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { AgentRunError } from '@/server/ai/agent-run-error';
import type { StructuredTaskResult } from '@/server/ai/judges/judge-output-parse';
import { taskPromptFingerprint } from '@/server/ai/provenance';
import { type RunTaskCtx, runTask } from '@/server/ai/runner';
import {
  persistValidatorRunBinding,
  runConfirmedStructuredReview,
} from '@/server/ai/sealed-validation';
import type { ToolExecutionResultObservation } from '@/server/ai/tools/mcp-bridge';
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
  projectCopilotEvidenceSourceCatalog,
  sourceCatalogDigest,
} from './evidence-submission';

export const COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY =
  '这轮证据审阅未能完成，现有结果无法裁决。为避免把推测当成事实，我无法安全复述本轮结论；已执行的工具动作记录不会因此回滚，请在对应页面核对后重试。';

/** Mirrors both inline evidence-task timeout budgets in the task registry. */
export const COPILOT_EVIDENCE_REVIEW_TIMEOUT_MS = 120_000;
/**
 * Complex durable traces can legitimately need more than the synchronous
 * validator tail. Keep this override reference-only until actual comparator
 * evidence demonstrates that its existing budget is insufficient.
 */
export const COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS = 360_000;
export const COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS = 2;
export const COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS = 2;
// Worst case: two blind-reference contract attempts, one failed original
// comparison, then two fallback confirmations. Keep one extra slot because a
// contract-invalid original pass attempt still consumes the bounded pair.
export const COPILOT_EVIDENCE_REVIEW_MAX_PASSES =
  COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS + COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS * 2;
export const COPILOT_DURABLE_EVIDENCE_REVIEW_TOTAL_TIMEOUT_MS =
  COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS * COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS +
  COPILOT_EVIDENCE_REVIEW_TIMEOUT_MS * COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS * 2;

const MAX_CANDIDATE_CHARS = 64_000;
const MAX_SERIALIZED_TRACE_CHARS = 160_000;
const MAX_SERIALIZED_REVIEW_INPUT_CHARS = 320_000;

export interface CopilotEvidenceReviewRunResult extends StructuredTaskResult {
  task_run_id?: string;
}

export type CopilotEvidenceReviewRunTaskFn = (
  kind: 'CopilotEvidenceReviewTask' | 'CopilotEvidenceVerificationTask',
  input: unknown,
  ctx: RunTaskCtx,
  submission: ReferenceEvidenceSubmission | ComparisonEvidenceSubmission,
) => Promise<CopilotEvidenceReviewRunResult>;

export interface CopilotEvidenceReviewDecision {
  status: 'skipped' | 'pass' | 'repair' | 'failed_closed';
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

async function runBlindReference(params: {
  db: Db;
  requestContext: unknown;
  requestUnits: ReturnType<typeof segmentEvidenceRequest>;
  sourceComplete: boolean;
  toolTrace: readonly ToolExecutionResultObservation[];
  signal?: AbortSignal;
  beforeVerification?: () => Promise<void>;
  attemptTimeoutMs?: number;
  runTaskFn: CopilotEvidenceReviewRunTaskFn;
}): Promise<
  | { ok: true; reference: BoundCopilotEvidenceReference; taskRunIds: string[] }
  | { ok: false; reason: string; taskRunIds: string[] }
> {
  const sourceCatalog = buildCopilotEvidenceSourceCatalog(params.toolTrace);
  const baseTaskInput = {
    protocol_version: 1,
    request_context: params.requestContext,
    request_units: params.requestUnits,
    source_complete: params.sourceComplete,
    tool_trace: params.toolTrace,
    source_catalog: projectCopilotEvidenceSourceCatalog(sourceCatalog, params.toolTrace.length),
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
  ensureSerializableBounded(referenceTaskInput, 'reference_input');
  const taskRunIds: string[] = [];
  let lastDetail = '';
  let contractFeedback: string | undefined;

  for (let attempt = 1; attempt <= COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS; attempt += 1) {
    const taskInput = contractFeedback
      ? {
          ...referenceTaskInput,
          contract_feedback: {
            previous_attempt: attempt - 1,
            rejection: contractFeedback,
          },
        }
      : referenceTaskInput;
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
    let result: CopilotEvidenceReviewRunResult;
    const submission = createReferenceEvidenceSubmission({
      requestUnits: params.requestUnits,
      toolTrace: params.toolTrace,
      sourceCatalog,
    });
    try {
      result = await params.runTaskFn(
        'CopilotEvidenceReviewTask',
        taskInput,
        {
          db: params.db,
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.attemptTimeoutMs !== undefined
            ? { budgetOverride: { timeoutMs: params.attemptTimeoutMs } }
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
      if (error instanceof AgentRunError && !taskRunIds.includes(error.taskRunId)) {
        taskRunIds.push(error.taskRunId);
      }
      lastDetail = `reference_task_failed:${error instanceof Error ? error.name : 'unknown'}`;
      continue;
    }
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
      await bindRunResult({
        db: params.db,
        kind: 'CopilotEvidenceReviewTask',
        taskInputSha256,
        taskRunId: result.task_run_id,
        resultDigest: reference.digest_sha256,
      });
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
  requestUnits: ReturnType<typeof segmentEvidenceRequest>;
  selectedReply: string;
  selectedTextKind: 'original' | 'blind_reference';
  sourceComplete: boolean;
  reference: BoundCopilotEvidenceReference;
  toolTrace: readonly ToolExecutionResultObservation[];
  signal?: AbortSignal;
  beforeVerification?: () => Promise<void>;
  attemptTimeoutMs?: number;
  runTaskFn: CopilotEvidenceReviewRunTaskFn;
}): Promise<
  | {
      status: 'decided';
      verdict: 'pass' | 'fail';
      comparison: BoundCopilotEvidenceComparison;
      taskRunIds: string[];
    }
  | { status: 'invalid'; reason: string; taskRunIds: string[] }
> {
  const replyUnits = segmentEvidenceReply(params.selectedReply);
  const selectedReplySha256 = sha256CanonicalJson({ text: params.selectedReply });
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
    tool_trace: params.toolTrace,
    submission_protocol: {
      kind: 'append_only_tools',
      max_reply_checks_per_call: 12,
      server_derives: ['request_checks', 'verdict', 'result_digest'],
    },
  };
  ensureSerializableBounded(baseTaskInput, 'comparison_input');
  let contractFeedback: string | undefined;

  const result = await runConfirmedStructuredReview<BoundCopilotEvidenceComparison>({
    maxAttempts: COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS,
    runAttempt: async (attempt) => {
      const taskInput = contractFeedback
        ? {
            ...baseTaskInput,
            contract_feedback: {
              previous_attempt: attempt - 1,
              rejection: contractFeedback,
            },
          }
        : baseTaskInput;
      ensureSerializableBounded(taskInput, 'comparison_input');
      const taskInputSha256 = sha256CanonicalJson(taskInput);
      try {
        await beforePaidCall(params);
      } catch (error) {
        if (params.signal?.aborted || isAbortError(error)) throw error;
        return {
          outcome: 'contract_invalid' as const,
          detail: `comparison_preflight_failed:${error instanceof Error ? error.name : 'unknown'}`,
        };
      }
      let taskResult: CopilotEvidenceReviewRunResult;
      const submission = createComparisonEvidenceSubmission({
        requestUnits: params.requestUnits,
        replyUnits,
        selectedReply: params.selectedReply,
        reference: params.reference,
        toolTrace: params.toolTrace,
        sourceComplete: params.sourceComplete,
      });
      try {
        taskResult = await params.runTaskFn(
          'CopilotEvidenceVerificationTask',
          taskInput,
          {
            db: params.db,
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.attemptTimeoutMs !== undefined
              ? { budgetOverride: { timeoutMs: params.attemptTimeoutMs } }
              : {}),
            mcpServers: { [COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME]: submission.mcpServer },
            allowedTools: [...COPILOT_EVIDENCE_COMPARISON_ALLOWED_TOOLS],
            autoLogToolCalls: false,
          },
          submission,
        );
      } catch (error) {
        if (params.signal?.aborted) throw error;
        return {
          outcome: 'contract_invalid' as const,
          ...(error instanceof AgentRunError ? { task_run_id: error.taskRunId } : {}),
          detail: `comparison_task_failed:${error instanceof Error ? error.name : 'unknown'}`,
        };
      }
      if (!taskResult.task_run_id) {
        return { outcome: 'contract_invalid' as const, detail: 'comparison_task_run_id_missing' };
      }

      const comparison = submission.completedComparison();
      if (!comparison) {
        const completion = submission.completeComparison();
        const detail = completion.ok ? 'submission_completion_missing' : completion.reason;
        contractFeedback = detail.slice(0, 240);
        console.warn('[copilot-evidence-review] comparator contract rejected', {
          attempt,
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
        } catch (bindingError) {
          return {
            outcome: 'contract_invalid' as const,
            task_run_id: taskResult.task_run_id,
            detail: `comparison_binding_failed:${bindingError instanceof Error ? bindingError.name : 'unknown'}`,
          };
        }
        return {
          outcome: 'contract_invalid' as const,
          task_run_id: taskResult.task_run_id,
          detail,
        };
      }

      try {
        await bindRunResult({
          db: params.db,
          kind: 'CopilotEvidenceVerificationTask',
          taskInputSha256,
          taskRunId: taskResult.task_run_id,
          resultDigest: comparison.digest_sha256,
        });
      } catch (bindingError) {
        return {
          outcome: 'contract_invalid' as const,
          task_run_id: taskResult.task_run_id,
          detail: `comparison_binding_failed:${bindingError instanceof Error ? bindingError.name : 'unknown'}`,
        };
      }
      return {
        outcome: 'valid' as const,
        task_run_id: taskResult.task_run_id,
        verdict: comparison.verdict,
        result: comparison,
      };
    },
  });
  const taskRunIds = result.attempts.flatMap((attempt) =>
    attempt.task_run_id ? [attempt.task_run_id] : [],
  );
  if (result.status === 'invalid') {
    return { status: 'invalid', reason: result.reason, taskRunIds };
  }
  return {
    status: 'decided',
    verdict: result.verdict,
    comparison: result.result,
    taskRunIds,
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
  runTaskFn?: CopilotEvidenceReviewRunTaskFn;
}): Promise<CopilotEvidenceReviewDecision> {
  if (!params.toolTrace.some((entry) => entry.effect === 'read')) {
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
      requestContext: params.requestContext,
      requestUnits,
      sourceComplete,
      toolTrace: params.toolTrace,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.beforeVerification ? { beforeVerification: params.beforeVerification } : {}),
      ...(params.attemptTimeouts?.referenceMs !== undefined
        ? { attemptTimeoutMs: params.attemptTimeouts.referenceMs }
        : {}),
      runTaskFn: run,
    });
  } catch (error) {
    if (params.signal?.aborted || isAbortError(error)) throw error;
    return failClosed(
      `reference_setup_failed:${error instanceof Error ? error.name : 'unknown'}`,
      params.candidateTaskRunId,
    );
  }
  if (!reference.ok) {
    return failClosed(reference.reason, params.candidateTaskRunId, {
      referenceTaskRunIds: reference.taskRunIds,
    });
  }

  let original: Awaited<ReturnType<typeof runConfirmedComparison>>;
  try {
    original = await runConfirmedComparison({
      db: params.db,
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
      runTaskFn: run,
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
      runTaskFn: run,
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
