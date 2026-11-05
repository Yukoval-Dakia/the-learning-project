import {
  INTERACTIVE_ARTIFACT_TOOL_NAMES,
  redactInteractiveArtifactToolInput,
} from '@/kernel/learning-content';
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

/** YUK-1763 — artifact-authoring args carry the answer key; never project it. */
function redactIfNeeded(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  return INTERACTIVE_ARTIFACT_TOOL_NAMES.has(toolName)
    ? redactInteractiveArtifactToolInput(input)
    : input;
}

/**
 * Native SDK Task spawn calls carry subagent prompts/instructions that must not
 * reach SPA tool-use cards. Public UX is projected via `subtask` SSE instead.
 */
export function sanitizeToolUseForSse(call: ToolUseSseCall): ToolUseSseCall | null {
  if (call.toolName === NATIVE_SPAWN_TOOL_NAME) return null;
  return call;
}

/** Defensive mirror of {@link sanitizeToolUseForSse} for done-state frames. */
export function sanitizeToolResultForSse(
  result: ToolResultSsePayload,
): ToolResultSsePayload | null {
  if (result.toolName === NATIVE_SPAWN_TOOL_NAME) return null;
  return result;
}

/** Project public execution activity before persisting it in reconnectable events. */
export function projectCopilotActivity(
  activity: CopilotExecutionActivity,
): Record<string, unknown> | null {
  switch (activity.kind) {
    case 'prose_delta':
    case 'spawn_budget':
      return null;
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
            input: redactIfNeeded(call.toolName, call.input),
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
            input: redactIfNeeded(result.toolName, result.input),
            summary: result.summary,
            ...(result.errorReason ? { error_reason: result.errorReason } : {}),
            ...(result.toolUseId ? { tool_use_id: result.toolUseId } : {}),
          }
        : null;
    }
  }
}
