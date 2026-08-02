import {
  type CopilotEvidenceReviewOutput,
  CopilotEvidenceReviewOutputSchema,
  type CopilotEvidenceVerificationOutput,
  CopilotEvidenceVerificationOutputSchema,
} from '@/ai/registry';
import type { Db } from '@/db/client';
import {
  type StructuredTaskResult,
  parseStructuredTaskOutput,
} from '@/server/ai/judges/judge-output-parse';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import { type RunTaskCtx, runTask } from '@/server/ai/runner';
import type { ToolExecutionResultObservation } from '@/server/ai/tools/mcp-bridge';

export const COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY =
  '这轮证据审阅未能完成，现有结果无法裁决。为避免把推测当成事实，我无法安全复述本轮结论；已执行的工具动作记录不会因此回滚，请在对应页面核对后重试。';

/** Mirrors CopilotEvidenceReviewTask.budget.timeout in the task registry. */
export const COPILOT_EVIDENCE_REVIEW_TIMEOUT_MS = 120_000;
export const COPILOT_EVIDENCE_REVIEW_MAX_PASSES = 2;
export const COPILOT_EVIDENCE_REVIEW_TOTAL_TIMEOUT_MS =
  COPILOT_EVIDENCE_REVIEW_TIMEOUT_MS * COPILOT_EVIDENCE_REVIEW_MAX_PASSES;

// The main Copilot surface already has a hard 25-call ceiling. This second pass
// receives only typed DomainTool projections, but an individual projection can
// still be large. Refuse oversized review input instead of silently truncating
// away the exact boundary that should govern the final claim.
const MAX_CANDIDATE_CHARS = 64_000;
const MAX_SERIALIZED_TRACE_CHARS = 160_000;
const MAX_SERIALIZED_REVIEW_INPUT_CHARS = 256_000;

const REVIEW_OUTPUT_FORMAT = zodToJsonSchemaOutputFormat(CopilotEvidenceReviewOutputSchema);
const VERIFICATION_OUTPUT_FORMAT = zodToJsonSchemaOutputFormat(
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
  reviewTaskRunId?: string;
  verificationTaskRunId?: string;
  violations?: string[];
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
  const parsed = parseStructuredTaskOutput(
    result,
    CopilotEvidenceReviewOutputSchema,
    'copilot evidence review output',
    { textMode: 'strict-json' },
  );
  if (parsed.verdict === 'repair' && Object.values(parsed.checks).every(Boolean)) {
    throw new Error('copilot evidence review repair must contain at least one failed check');
  }
  if (parsed.verdict === 'repair' && parsed.safe_reply.trim().length === 0) {
    throw new Error('copilot evidence review repair must contain a non-empty safe reply');
  }
  if (parsed.verdict === 'repair' && parsed.safe_reply.includes('<!--primary_view')) {
    throw new Error('copilot evidence review repair must not nominate a primary view');
  }
  return parsed;
}

export function parseCopilotEvidenceVerificationResult(
  result: StructuredTaskResult,
): CopilotEvidenceVerificationOutput {
  const parsed = parseStructuredTaskOutput(
    result,
    CopilotEvidenceVerificationOutputSchema,
    'copilot evidence verification output',
    { textMode: 'strict-json' },
  );
  if (parsed.verdict === 'reject' && Object.values(parsed.checks).every(Boolean)) {
    throw new Error('copilot evidence verification reject must contain at least one failed check');
  }
  return parsed;
}

function failClosed(reason: string, candidateTaskRunId: string): CopilotEvidenceReviewDecision {
  console.warn('[copilot-evidence-review] fail closed', {
    event: 'copilot_evidence_review_fail_closed',
    candidate_task_run_id: candidateTaskRunId,
    reason,
  });
  return {
    status: 'failed_closed',
    replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
  };
}

async function runReviewRound(params: {
  db: Db;
  requestContext: unknown;
  candidateReply: string;
  candidateTaskRunId: string;
  candidateComplete: boolean;
  toolTrace: readonly ToolExecutionResultObservation[];
  signal?: AbortSignal;
  runTaskFn: CopilotEvidenceReviewRunTaskFn;
}): Promise<
  | { ok: true; parsed: CopilotEvidenceReviewOutput; result: CopilotEvidenceReviewRunResult }
  | { ok: false; reason: string }
> {
  const reviewInput = {
    request_context: params.requestContext,
    candidate_reply: params.candidateReply,
    candidate_task_run_id: params.candidateTaskRunId,
    candidate_complete: params.candidateComplete,
    review_round: 'initial',
    tool_trace: params.toolTrace,
  };
  let serializedReviewInput: string;
  try {
    serializedReviewInput = JSON.stringify(reviewInput);
  } catch {
    return { ok: false, reason: 'initial_input_not_serializable' };
  }
  if (serializedReviewInput.length > MAX_SERIALIZED_REVIEW_INPUT_CHARS) {
    return { ok: false, reason: 'initial_input_too_large' };
  }

  let result: CopilotEvidenceReviewRunResult;
  try {
    result = await params.runTaskFn('CopilotEvidenceReviewTask', reviewInput, {
      db: params.db,
      ...(params.signal ? { signal: params.signal } : {}),
      outputFormat: REVIEW_OUTPUT_FORMAT,
    });
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return {
      ok: false,
      reason: `initial_task_failed:${error instanceof Error ? error.name : 'unknown'}`,
    };
  }

  try {
    return { ok: true, parsed: parseCopilotEvidenceReviewResult(result), result };
  } catch (error) {
    return {
      ok: false,
      reason: `initial_output_invalid:${error instanceof Error ? error.name : 'unknown'}`,
    };
  }
}

async function runVerificationRound(params: {
  db: Db;
  requestContext: unknown;
  finalReply: string;
  finalTextKind: 'original' | 'repair';
  sourceComplete: boolean;
  toolTrace: readonly ToolExecutionResultObservation[];
  signal?: AbortSignal;
  runTaskFn: CopilotEvidenceReviewRunTaskFn;
}): Promise<
  | {
      ok: true;
      parsed: CopilotEvidenceVerificationOutput;
      result: CopilotEvidenceReviewRunResult;
    }
  | { ok: false; reason: string }
> {
  const verificationInput = {
    request_context: params.requestContext,
    final_reply: params.finalReply,
    final_text_kind: params.finalTextKind,
    source_complete: params.sourceComplete,
    tool_trace: params.toolTrace,
  };
  let serializedVerificationInput: string;
  try {
    serializedVerificationInput = JSON.stringify(verificationInput);
  } catch {
    return { ok: false, reason: 'verification_input_not_serializable' };
  }
  if (serializedVerificationInput.length > MAX_SERIALIZED_REVIEW_INPUT_CHARS) {
    return { ok: false, reason: 'verification_input_too_large' };
  }

  let result: CopilotEvidenceReviewRunResult;
  try {
    result = await params.runTaskFn('CopilotEvidenceVerificationTask', verificationInput, {
      db: params.db,
      ...(params.signal ? { signal: params.signal } : {}),
      outputFormat: VERIFICATION_OUTPUT_FORMAT,
    });
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return {
      ok: false,
      reason: `verification_task_failed:${error instanceof Error ? error.name : 'unknown'}`,
    };
  }

  try {
    return { ok: true, parsed: parseCopilotEvidenceVerificationResult(result), result };
  } catch (error) {
    return {
      ok: false,
      reason: `verification_output_invalid:${error instanceof Error ? error.name : 'unknown'}`,
    };
  }
}

export async function reviewCopilotEvidenceReply(params: {
  db: Db;
  requestContext: unknown;
  candidateReply: string;
  candidateTaskRunId: string;
  /** False when the primary stream returned a graceful-degrade partial. */
  candidateComplete?: boolean;
  toolTrace: readonly ToolExecutionResultObservation[];
  signal?: AbortSignal;
  /** Optional durable-truth probe immediately before starting paid verification. */
  beforeVerification?: () => Promise<void>;
  runTaskFn?: CopilotEvidenceReviewRunTaskFn;
}): Promise<CopilotEvidenceReviewDecision> {
  if (!params.toolTrace.some((entry) => entry.effect === 'read')) {
    return { status: 'skipped', replyText: params.candidateReply };
  }
  if (params.candidateReply.length > MAX_CANDIDATE_CHARS) {
    return failClosed('candidate_too_large', params.candidateTaskRunId);
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
  const candidateComplete = params.candidateComplete ?? true;
  params.signal?.throwIfAborted();
  const initial = await runReviewRound({
    db: params.db,
    requestContext: params.requestContext,
    candidateReply: params.candidateReply,
    candidateTaskRunId: params.candidateTaskRunId,
    candidateComplete,
    toolTrace: params.toolTrace,
    ...(params.signal ? { signal: params.signal } : {}),
    runTaskFn: run,
  });
  if (!initial.ok) return failClosed(initial.reason, params.candidateTaskRunId);
  params.signal?.throwIfAborted();
  await params.beforeVerification?.();
  params.signal?.throwIfAborted();

  const { parsed, result } = initial;

  if (parsed.verdict === 'pass') {
    if (!candidateComplete) {
      return failClosed('partial_candidate_passed_review', params.candidateTaskRunId);
    }
  }

  // A repair is model-authored prose too. It is never user-visible merely
  // because the same task that found a violation also rewrote it. Re-run the
  // generic contract independently over the selected bytes and the exact same
  // typed trace. The separate verifier has no rewrite field and may only
  // certify or reject; every non-certification fails closed.
  const selectedReply = parsed.verdict === 'pass' ? params.candidateReply : parsed.safe_reply;
  const verification = await runVerificationRound({
    db: params.db,
    requestContext: params.requestContext,
    finalReply: selectedReply,
    finalTextKind: parsed.verdict === 'pass' ? 'original' : 'repair',
    sourceComplete: candidateComplete,
    toolTrace: params.toolTrace,
    ...(params.signal ? { signal: params.signal } : {}),
    runTaskFn: run,
  });
  if (!verification.ok) return failClosed(verification.reason, params.candidateTaskRunId);
  params.signal?.throwIfAborted();
  if (verification.parsed.verdict !== 'certify') {
    return failClosed('verification_rejected_selected_reply', params.candidateTaskRunId);
  }

  if (parsed.verdict === 'pass') {
    return {
      status: 'pass',
      replyText: params.candidateReply,
      ...(result.task_run_id ? { reviewTaskRunId: result.task_run_id } : {}),
      ...(verification.result.task_run_id
        ? { verificationTaskRunId: verification.result.task_run_id }
        : {}),
    };
  }
  return {
    status: 'repair',
    replyText: parsed.safe_reply,
    violations: parsed.violations,
    ...(result.task_run_id ? { reviewTaskRunId: result.task_run_id } : {}),
    ...(verification.result.task_run_id
      ? { verificationTaskRunId: verification.result.task_run_id }
      : {}),
  };
}
