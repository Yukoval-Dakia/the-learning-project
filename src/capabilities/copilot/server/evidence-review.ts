import { type CopilotEvidenceReviewOutput, CopilotEvidenceReviewOutputSchema } from '@/ai/registry';
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

// The main Copilot surface already has a hard 25-call ceiling. This second pass
// receives only typed DomainTool projections, but an individual projection can
// still be large. Refuse oversized review input instead of silently truncating
// away the exact boundary that should govern the final claim.
const MAX_CANDIDATE_CHARS = 64_000;
const MAX_SERIALIZED_TRACE_CHARS = 160_000;
const MAX_SERIALIZED_REVIEW_INPUT_CHARS = 256_000;

const OUTPUT_FORMAT = zodToJsonSchemaOutputFormat(CopilotEvidenceReviewOutputSchema);

export interface CopilotEvidenceReviewRunResult extends StructuredTaskResult {
  task_run_id?: string;
}

export type CopilotEvidenceReviewRunTaskFn = (
  kind: 'CopilotEvidenceReviewTask',
  input: unknown,
  ctx: RunTaskCtx,
) => Promise<CopilotEvidenceReviewRunResult>;

export interface CopilotEvidenceReviewDecision {
  status: 'skipped' | 'pass' | 'repair' | 'failed_closed';
  replyText: string;
  reviewTaskRunId?: string;
  violations?: string[];
}

async function defaultRunTaskFn(
  kind: 'CopilotEvidenceReviewTask',
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

export async function reviewCopilotEvidenceReply(params: {
  db: Db;
  requestContext: unknown;
  candidateReply: string;
  candidateTaskRunId: string;
  /** False when the primary stream returned a graceful-degrade partial. */
  candidateComplete?: boolean;
  toolTrace: readonly ToolExecutionResultObservation[];
  signal?: AbortSignal;
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

  const reviewInput = {
    request_context: params.requestContext,
    candidate_reply: params.candidateReply,
    candidate_task_run_id: params.candidateTaskRunId,
    candidate_complete: params.candidateComplete ?? true,
    tool_trace: params.toolTrace,
  };
  let serializedReviewInput: string;
  try {
    serializedReviewInput = JSON.stringify(reviewInput);
  } catch {
    return failClosed('review_input_not_serializable', params.candidateTaskRunId);
  }
  if (serializedReviewInput.length > MAX_SERIALIZED_REVIEW_INPUT_CHARS) {
    return failClosed('review_input_too_large', params.candidateTaskRunId);
  }

  const run = params.runTaskFn ?? defaultRunTaskFn;
  let result: CopilotEvidenceReviewRunResult;
  try {
    result = await run('CopilotEvidenceReviewTask', reviewInput, {
      db: params.db,
      ...(params.signal ? { signal: params.signal } : {}),
      outputFormat: OUTPUT_FORMAT,
    });
  } catch (error) {
    return failClosed(
      `task_failed:${error instanceof Error ? error.name : 'unknown'}`,
      params.candidateTaskRunId,
    );
  }

  let parsed: CopilotEvidenceReviewOutput;
  try {
    parsed = parseCopilotEvidenceReviewResult(result);
  } catch (error) {
    return failClosed(
      `output_invalid:${error instanceof Error ? error.name : 'unknown'}`,
      params.candidateTaskRunId,
    );
  }

  if (parsed.verdict === 'pass') {
    if (params.candidateComplete === false) {
      return failClosed('partial_candidate_passed_review', params.candidateTaskRunId);
    }
    return {
      status: 'pass',
      replyText: params.candidateReply,
      ...(result.task_run_id ? { reviewTaskRunId: result.task_run_id } : {}),
    };
  }
  return {
    status: 'repair',
    replyText: parsed.safe_reply,
    violations: parsed.violations,
    ...(result.task_run_id ? { reviewTaskRunId: result.task_run_id } : {}),
  };
}
