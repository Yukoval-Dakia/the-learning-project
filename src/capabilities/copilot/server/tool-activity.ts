import { projectLearnerToolInput } from '@/kernel/learning-content';
import type { CopilotExecutionActivity } from './copilot-execution';

/** Must stay aligned with SPAWN_TOOL_NAME in src/core/subagent-contract.ts */
const NATIVE_SPAWN_TOOL_NAME = 'Task';

export interface ToolUseSseCall {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
}

export interface ToolResultSsePayload {
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  errorReason?: string;
  /** 同名并行 call 的确定性关联 id；有则投影进 SSE。 */
  toolUseId?: string;
}

/**
 * Native SDK Task spawn calls carry subagent prompts/instructions that must not
 * reach SPA tool-use cards. Public UX is projected via `subtask` SSE instead.
 */
export function sanitizeToolUseForSse(call: ToolUseSseCall): ToolUseSseCall | null {
  if (call.toolName === NATIVE_SPAWN_TOOL_NAME) return null;
  return { ...call, input: projectLearnerToolInput(call.toolName, call.input) };
}

/** Defensive mirror of {@link sanitizeToolUseForSse} for done-state frames. */
export function sanitizeToolResultForSse(
  result: ToolResultSsePayload,
): ToolResultSsePayload | null {
  if (result.toolName === NATIVE_SPAWN_TOOL_NAME) return null;
  return { ...result, input: projectLearnerToolInput(result.toolName, result.input) };
}

/** Project public execution activity before persisting it in reconnectable events. */
export function projectCopilotActivity(
  activity: CopilotExecutionActivity,
): Record<string, unknown> | null {
  switch (activity.kind) {
    case 'prose_delta':
    case 'spawn_budget':
    case 'thinking_delta':
      // thinking_delta rides the display-only live lane; reasoning text must
      // never enter the persisted frame stream.
      return null;
    case 'request_sent':
      return {
        step_kind: 'request_sent',
        task_run_id: activity.taskRunId,
        ...(activity.retryOfTaskRunId ? { retry_of: activity.retryOfTaskRunId } : {}),
      };
    case 'thinking_end':
      return {
        step_kind: 'thinking_end',
        task_run_id: activity.taskRunId,
        result: activity.result,
      };
    case 'provider_retry':
      return {
        step_kind: 'provider_retry',
        label: '现在有点挤，再试一次',
        retry: activity.retry,
        delay_ms: activity.delayMs,
      };
    case 'request_retry':
      return {
        step_kind: 'request_retry',
        task_run_id: activity.taskRunId,
        retry: activity.retry,
        max_retries: activity.maxRetries,
        reason: activity.reason,
        discard_chars: activity.discardProseChars,
        discard_thinking_chars: activity.discardThinkingChars,
      };
    case 'model_thinking':
      return { step_kind: 'model_thinking' };
    case 'block_draft':
      return {
        step_kind: 'block_draft',
        tool_use_id: activity.toolUseId,
        received_bytes: activity.receivedBytes,
        ...(activity.blockKind ? { kind: activity.blockKind } : {}),
        ...(activity.title ? { title: activity.title } : {}),
      };
    case 'block_ready':
      return {
        step_kind: 'block_ready',
        tool_use_id: activity.toolUseId,
        ref: activity.ref,
        block: activity.block,
      };
    case 'subtask': {
      const { step_kind, subtask_id, label, status, error } = activity.event;
      return {
        step_kind,
        subtask_id,
        label,
        status,
        ...(error ? { error } : {}),
      };
    }
    case 'tool_started': {
      const call = sanitizeToolUseForSse(activity);
      return call
        ? {
            step_kind: 'tool_started',
            tool_name: call.toolName,
            input: call.input,
            ...(call.toolUseId ? { tool_use_id: call.toolUseId } : {}),
          }
        : null;
    }
    case 'tool_finished': {
      const result = sanitizeToolResultForSse(activity);
      return result
        ? {
            step_kind: 'tool_finished',
            tool_name: result.toolName,
            input: result.input,
            summary: result.summary,
            ...(result.errorReason ? { error_reason: result.errorReason } : {}),
            ...(result.toolUseId ? { tool_use_id: result.toolUseId } : {}),
          }
        : null;
    }
  }
}
