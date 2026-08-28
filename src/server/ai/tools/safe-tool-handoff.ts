import {
  type ToolOperationCancellationOwner,
  type ToolOperationJson,
  type ToolOperationRecord,
  type ToolOperations,
  controlOwnedToolOperation,
} from '@/kernel/tools/tool-operations';

export const SAFE_TOOL_OPERATION_YIELD_MS = 45_000;

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
