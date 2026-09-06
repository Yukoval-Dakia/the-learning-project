import type { CopilotExecutionActivity } from './copilot-execution';

/** Must stay aligned with SPAWN_TOOL_NAME in src/server/ai/spawn-contract.ts */
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
    case 'spawn_budget':
      return null;
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
          }
        : null;
    }
  }
}
