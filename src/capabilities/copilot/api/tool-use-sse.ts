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
