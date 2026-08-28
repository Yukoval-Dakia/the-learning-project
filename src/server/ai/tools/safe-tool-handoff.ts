import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type {
  ToolOperationCancellationOwner,
  ToolOperationJson,
  ToolOperationRecord,
  ToolOperations,
} from '@/kernel/tools/tool-operations';

export const SAFE_TOOL_OPERATION_YIELD_MS = 45_000;
export const SAFE_TOOL_OPERATION_WAIT_MAX_MS = 5_000;

export type SafeToolOperationExecution =
  | { kind: 'settled'; record: ToolOperationRecord }
  | {
      kind: 'yielded';
      operation: { id: string; status: 'running'; tool_use_id?: string };
    };

export async function executeSafeToolOperation(options: {
  toolOperations: ToolOperations;
  sessionId: string;
  taskRunId: string;
  toolName: string;
  toolUseId?: string;
  input: ToolOperationJson;
  hardDeadlineAt?: Date;
  yieldAfterMs?: number;
  cancellationSignals?: ReadonlyArray<{
    signal: AbortSignal;
    requestedBy: ToolOperationCancellationOwner;
  }>;
  execute(signal: AbortSignal): Promise<unknown>;
}): Promise<SafeToolOperationExecution> {
  const handle = await options.toolOperations.start(
    {
      sessionId: options.sessionId,
      taskRunId: options.taskRunId,
      toolName: options.toolName,
      effect: 'read',
      input: {
        args: options.input,
        ...(options.toolUseId ? { tool_use_id: options.toolUseId } : {}),
      },
      hardDeadlineAt: options.hardDeadlineAt,
    },
    async ({ signal }) => {
      try {
        const output = await options.execute(signal);
        if (signal.aborted) {
          return {
            status: 'cancelled',
            error: { code: 'cancelled', message: 'Remote read cancelled by its owner' },
          };
        }
        if (output === null || typeof output !== 'object' || Array.isArray(output)) {
          return {
            status: 'failed',
            error: {
              code: 'result_contract_invalid',
              message: 'Safe remote tool result must be a JSON object',
            },
          };
        }
        return { status: 'succeeded', result: output as ToolOperationJson };
      } catch (error) {
        if (signal.aborted) {
          return {
            status: 'cancelled',
            error: { code: 'cancelled', message: 'Remote read cancelled by its owner' },
          };
        }
        return {
          status: 'failed',
          error: {
            code: 'execution_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  );
  const cancellationSignals = options.cancellationSignals ?? [];
  let cancellationScheduled = false;
  const scheduleCancellation = () => {
    if (cancellationScheduled) return;
    cancellationScheduled = true;
    queueMicrotask(() => {
      const requestedBy = cancellationSignals
        .filter((cancellation) => cancellation.signal.aborted)
        .map((cancellation) => cancellation.requestedBy)
        .sort((left, right) => {
          const rank = { system: 1, model: 2, user: 3 } as const;
          return rank[right] - rank[left];
        })[0];
      if (!requestedBy) return;
      void controlOwnedToolOperation(options.toolOperations, {
        action: 'cancel',
        operationId: handle.id,
        sessionId: options.sessionId,
        taskRunId: options.taskRunId,
        requestedBy,
      }).catch(() => undefined);
    });
  };
  for (const cancellation of cancellationSignals) {
    if (cancellation.signal.aborted) scheduleCancellation();
    else cancellation.signal.addEventListener('abort', scheduleCancellation, { once: true });
  }
  const record = await options.toolOperations.wait(handle.id, {
    timeoutMs: options.yieldAfterMs ?? SAFE_TOOL_OPERATION_YIELD_MS,
  });
  if (record.status !== 'running') return { kind: 'settled', record };
  return {
    kind: 'yielded',
    operation: {
      id: record.id,
      status: 'running',
      ...(options.toolUseId ? { tool_use_id: options.toolUseId } : {}),
    },
  };
}

export type OwnedToolOperationControl = {
  action: 'get' | 'wait' | 'cancel';
  operationId: string;
  sessionId: string;
  taskRunId: string;
  requestedBy: ToolOperationCancellationOwner;
  timeoutMs?: number;
};

export async function controlOwnedToolOperation(
  toolOperations: ToolOperations,
  control: OwnedToolOperationControl,
): Promise<ToolOperationRecord> {
  const owned = await toolOperations.get(control.operationId);
  if (owned.sessionId !== control.sessionId) {
    throw new Error('tool operation not found');
  }
  if (control.action === 'get') return owned;
  if (control.action === 'wait') {
    const timeoutMs = control.timeoutMs ?? 0;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > SAFE_TOOL_OPERATION_WAIT_MAX_MS
    ) {
      throw new Error(
        `timeoutMs must be an integer between 0 and ${SAFE_TOOL_OPERATION_WAIT_MAX_MS}`,
      );
    }
    return toolOperations.wait(control.operationId, { timeoutMs });
  }
  return toolOperations.cancel(control.operationId, { requestedBy: control.requestedBy });
}

export interface ToolUseCorrelation {
  hooks: NonNullable<Options['hooks']>;
  claim(toolName: string, input: unknown): string | undefined;
  prepend(existing?: Options['hooks']): NonNullable<Options['hooks']>;
}

export function createToolUseCorrelation(serverName: string): ToolUseCorrelation {
  const pending = new Map<string, string[]>();
  const prefix = `mcp__${serverName}__`;
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || !input.tool_name.startsWith(prefix)) {
      return { continue: true };
    }
    const toolName = input.tool_name.slice(prefix.length);
    if (toolName === 'run_task') return { continue: true };
    const key = `${toolName}:${sha256CanonicalJson(input.tool_input)}`;
    pending.set(key, [...(pending.get(key) ?? []), input.tool_use_id]);
    return { continue: true };
  };
  const hooks: NonNullable<Options['hooks']> = { PreToolUse: [{ hooks: [hook] }] };
  return {
    hooks,
    claim(toolName, input) {
      if (toolName === 'run_task') return undefined;
      const key = `${toolName}:${sha256CanonicalJson(input)}`;
      const ids = pending.get(key);
      const claimed = ids?.shift();
      if (ids?.length === 0) pending.delete(key);
      return claimed;
    },
    prepend(existing) {
      return {
        ...(existing ?? {}),
        PreToolUse: [{ hooks: [hook] }, ...(existing?.PreToolUse ?? [])],
      };
    },
  };
}
