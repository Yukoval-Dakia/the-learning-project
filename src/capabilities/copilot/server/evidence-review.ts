import {
  type CopilotEvidenceReviewOutput,
  CopilotEvidenceReviewOutputSchema,
  type CopilotEvidenceVerificationOutput,
  CopilotEvidenceVerificationOutputSchema,
} from '@/ai/registry';
import { COPILOT_EVIDENCE_MAX_TRACE_CALLS } from '@/core/copilot-evidence';
import type { Db } from '@/db/client';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { AgentRunError } from '@/server/ai/agent-run-error';
import {
  type StructuredTaskResult,
  parseStructuredTaskOutput,
} from '@/server/ai/judges/judge-output-parse';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
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
  bindCopilotEvidenceComparison,
  bindCopilotEvidenceReference,
  safeValidationErrorDetail,
  segmentEvidenceReply,
  segmentEvidenceRequest,
} from './evidence-contract';

export const COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY =
  '这轮证据审阅未能完成，现有结果无法裁决。为避免把推测当成事实，我无法安全复述本轮结论；已执行的工具动作记录不会因此回滚，请在对应页面核对后重试。';

/** Mirrors both inline evidence-task timeout budgets in the task registry. */
export const COPILOT_EVIDENCE_REVIEW_TIMEOUT_MS = 120_000;
/**
 * Complex durable traces can legitimately need more than the synchronous
 * validator tail. Keep this override reference-only until actual comparator
 * evidence demonstrates that its existing budget is insufficient.
 */
export const COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS = 240_000;
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

const REFERENCE_OUTPUT_FORMAT = zodToJsonSchemaOutputFormat(CopilotEvidenceReviewOutputSchema);
const COMPARISON_OUTPUT_FORMAT = zodToJsonSchemaOutputFormat(
  CopilotEvidenceVerificationOutputSchema,
);

export interface CopilotEvidenceReviewRunResult extends StructuredTaskResult {
  task_run_id?: string;
}

export type CopilotEvidenceReviewRunTaskFn = (
  kind: 'CopilotEvidenceReviewTask' | 'CopilotEvidenceVerificationTask',
  input: unknown,
  ctx: RunTaskCtx,
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

function normalizeEvidenceJsonEnvelope(result: StructuredTaskResult): StructuredTaskResult {
  if (result.structured_output !== undefined && result.structured_output !== null) return result;
  const trimmed = result.text.trim();
  // Xiaomi does not support the SDK structured-output protocol and actual
  // validator runs may wrap an otherwise strict JSON object in one Markdown
  // code fence. Accept that syntax-only envelope, but still reject prose,
  // multiple fences, or any bytes outside the single fence. Zod + server
  // binding remain the authority over the enclosed object.
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return match?.[1] === undefined ? result : { ...result, text: match[1] };
}

async function defaultRunTaskFn(
  kind: 'CopilotEvidenceReviewTask' | 'CopilotEvidenceVerificationTask',
  input: unknown,
  ctx: RunTaskCtx,
): Promise<CopilotEvidenceReviewRunResult> {
  return runTask(kind, input, ctx);
}

export function parseCopilotEvidenceReviewResult(
  result: StructuredTaskResult,
): CopilotEvidenceReviewOutput {
  return parseStructuredTaskOutput(
    normalizeEvidenceJsonEnvelope(result),
    CopilotEvidenceReviewOutputSchema,
    'copilot blind evidence reference output',
    { textMode: 'strict-json' },
  );
}

export function parseCopilotEvidenceVerificationResult(
  result: StructuredTaskResult,
): CopilotEvidenceVerificationOutput {
  return parseStructuredTaskOutput(
    normalizeEvidenceJsonEnvelope(result),
    CopilotEvidenceVerificationOutputSchema,
    'copilot sealed evidence comparison output',
    { textMode: 'strict-json' },
  );
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
  const taskInput = {
    protocol_version: 1,
    request_context: params.requestContext,
    request_units: params.requestUnits,
    source_complete: params.sourceComplete,
    tool_trace: params.toolTrace,
  };
  ensureSerializableBounded(taskInput, 'reference_input');
  const taskInputSha256 = sha256CanonicalJson(taskInput);
  const taskRunIds: string[] = [];
  let lastDetail = '';

  for (let attempt = 1; attempt <= COPILOT_EVIDENCE_REFERENCE_MAX_ATTEMPTS; attempt += 1) {
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
    try {
      result = await params.runTaskFn('CopilotEvidenceReviewTask', taskInput, {
        db: params.db,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.attemptTimeoutMs !== undefined
          ? { budgetOverride: { timeoutMs: params.attemptTimeoutMs } }
          : {}),
        outputFormat: REFERENCE_OUTPUT_FORMAT,
      });
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

    let reference: BoundCopilotEvidenceReference;
    try {
      const parsed = parseCopilotEvidenceReviewResult(result);
      reference = bindCopilotEvidenceReference({
        value: parsed,
        requestUnits: params.requestUnits,
        toolTrace: params.toolTrace,
      });
    } catch (error) {
      lastDetail = `reference_output_invalid:${safeValidationErrorDetail(error)}`;
      console.warn('[copilot-evidence-review] blind reference contract rejected', {
        attempt,
        issues: safeValidationErrorDetail(error),
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
  const taskInput = {
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
  };
  ensureSerializableBounded(taskInput, 'comparison_input');
  const taskInputSha256 = sha256CanonicalJson(taskInput);

  const result = await runConfirmedStructuredReview<BoundCopilotEvidenceComparison>({
    maxAttempts: COPILOT_EVIDENCE_COMPARISON_MAX_ATTEMPTS,
    runAttempt: async (attempt) => {
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
      try {
        taskResult = await params.runTaskFn('CopilotEvidenceVerificationTask', taskInput, {
          db: params.db,
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.attemptTimeoutMs !== undefined
            ? { budgetOverride: { timeoutMs: params.attemptTimeoutMs } }
            : {}),
          outputFormat: COMPARISON_OUTPUT_FORMAT,
        });
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

      let comparison: BoundCopilotEvidenceComparison;
      try {
        const parsed = parseCopilotEvidenceVerificationResult(taskResult);
        comparison = bindCopilotEvidenceComparison({
          value: parsed,
          requestUnits: params.requestUnits,
          replyUnits,
          reference: params.reference,
          toolTrace: params.toolTrace,
          sourceComplete: params.sourceComplete,
          selectedReplySha256,
        });
      } catch (error) {
        const detail = safeValidationErrorDetail(error);
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
  const reference = await runBlindReference({
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
