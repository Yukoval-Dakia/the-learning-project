import { sha256CanonicalJson } from '@/kernel/canonical-json';

/** Stop before the second consecutive call with the same canonical args. */
export const TOOL_STALL_SAME_CALL_LIMIT = 2;
/** Quiet time with no new prose and no in-flight tool. */
export const TOOL_STALL_NO_PROGRESS_MS = 3 * 60 * 1000;

export type ToolStall =
  | {
      kind: 'same_call';
      toolName: string;
      argsHash: string;
      count: number;
    }
  | {
      kind: 'no_progress';
      quietMs: number;
    };

export interface ToolStallTracker {
  readonly stall: ToolStall | undefined;
  observeOutput(text: string): void;
  beforeCall(call: { id: string; name: string; args: unknown }): ToolStall | undefined;
  toolSettled(id: string): void;
}

interface ToolCallStreak {
  toolName: string;
  argsHash: string;
  count: number;
}

export function createToolStall(options?: { now?: () => number }): ToolStallTracker {
  const now = options?.now ?? Date.now;
  let stall: ToolStall | undefined;
  let lastProgressAt = now();
  let streak: ToolCallStreak | undefined;
  const inFlight = new Set<string>();

  return {
    get stall() {
      return stall;
    },
    observeOutput(text) {
      if (stall || text.length === 0) return;
      lastProgressAt = now();
    },
    beforeCall(call) {
      if (stall) return stall;
      const argsHash = sha256CanonicalJson(call.args ?? {});
      if (inFlight.size === 0) {
        const quietMs = now() - lastProgressAt;
        if (quietMs >= TOOL_STALL_NO_PROGRESS_MS) {
          stall = { kind: 'no_progress', quietMs };
          return stall;
        }
      }
      streak =
        streak && streak.toolName === call.name && streak.argsHash === argsHash
          ? { toolName: call.name, argsHash, count: streak.count + 1 }
          : { toolName: call.name, argsHash, count: 1 };
      if (streak.count >= TOOL_STALL_SAME_CALL_LIMIT) {
        stall = {
          kind: 'same_call',
          toolName: call.name,
          argsHash,
          count: streak.count,
        };
        return stall;
      }
      inFlight.add(call.id);
      return undefined;
    },
    toolSettled(id) {
      if (!inFlight.delete(id) || stall) return;
      lastProgressAt = now();
    },
  };
}

export function toolStallReason(stall: ToolStall): string {
  if (stall.kind === 'same_call') {
    return `stalled: same_call ${stall.toolName} x${stall.count}`;
  }
  return `stalled: no_progress ${stall.quietMs}ms`;
}
