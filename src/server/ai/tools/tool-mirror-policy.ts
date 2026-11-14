import type { ToolCallerActor, ToolEffect, ToolMirrorPolicy } from '@/kernel/tools/types';
import { isPrivateTraceContent } from '../laminar-tracing';
import { getTool } from './registry';

type ToolObservation =
  | {
      kind: 'tool_started';
      toolName: string;
      input: Record<string, unknown>;
      toolUseId?: string;
    }
  | {
      kind: 'tool_finished';
      toolName: string;
      input: Record<string, unknown>;
      toolUseId?: string;
      summary: string;
      errorReason?: string;
    };

/** Project before an observer queues work outside the originating private scope. */
export function projectToolObservationForPersistence(
  observation: ToolObservation,
): ToolObservation {
  if (!isPrivateTraceContent()) return observation;
  const metadata = {
    toolName: observation.toolName,
    input: { content_omitted: true },
    ...(observation.toolUseId ? { toolUseId: observation.toolUseId } : {}),
  };
  return observation.kind === 'tool_started'
    ? { kind: 'tool_started', ...metadata }
    : {
        kind: 'tool_finished',
        ...metadata,
        summary: observation.errorReason ? 'Tool failed' : 'Tool completed',
        ...(observation.errorReason ? { errorReason: 'private_tool_failed' } : {}),
      };
}

function matchesAgentRef(ref: string, family: string): boolean {
  const bare = ref.replace(/^agent:/i, '').toLowerCase();
  return bare === family || bare.startsWith(`${family}:`);
}

/**
 * Whether one call mirrors to the `event` table. `ToolUseQuery` requires
 * actor_kind='agent', so user-fired calls never mirror. Declared policies:
 *
 *   - 'never'             → never
 *   - 'always'            → always (agent callers only)
 *   - 'when_user_visible' → copilot / teaching caller_ref
 *   - 'when_causal'       → propose | write effect, or dreaming caller_ref
 *
 * Exported with `__` so tests can pin the policy table.
 */
export function __resolveMirrorPolicy(
  policy: ToolMirrorPolicy,
  callerActor: ToolCallerActor,
  effect: ToolEffect,
): boolean {
  if (callerActor.kind !== 'agent') return false;
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  if (policy === 'when_user_visible') {
    return (
      matchesAgentRef(callerActor.ref, 'copilot') || matchesAgentRef(callerActor.ref, 'teaching')
    );
  }
  // when_causal
  if (effect === 'propose' || effect === 'write') return true;
  return matchesAgentRef(callerActor.ref, 'dreaming');
}

/**
 * YUK-457 — live tool_use SSE gate. Applies the same mirror policy that governs
 * the persisted mirror, so live cards and replay cannot diverge. Names outside
 * this server and unregistered suffixes pass through: their visibility is
 * governed elsewhere (subtask SSE / finalize force-done).
 */
export function shouldEmitToolUseForCaller(
  blockName: string,
  serverName: string,
  callerActor: ToolCallerActor,
): boolean {
  const prefix = `mcp__${serverName}__`;
  if (!blockName.startsWith(prefix)) return true;
  const dt = getTool(blockName.slice(prefix.length));
  if (!dt) return true;
  return __resolveMirrorPolicy(dt.mirrorEvent, callerActor, dt.effect);
}
