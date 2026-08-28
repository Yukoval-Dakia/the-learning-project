import { z } from 'zod';
import {
  SAFE_TOOL_OPERATION_WAIT_MAX_MS,
  type ToolOperationRecord,
  controlOwnedToolOperation,
  getProcessToolOperations,
} from '@/kernel/tools/tool-operations';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';

const ToolOperationControlOutputSchema = z.object({
  operation_id: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'lost']),
  tool_name: z.string(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  side_effect_risk: z.enum(['none', 'possible']).nullable(),
  cancelled_by: z.enum(['model', 'system', 'user']).nullable(),
});

type ToolOperationControlOutput = z.infer<typeof ToolOperationControlOutputSchema>;

function owner(ctx: ToolContext): string {
  if (!ctx.sessionId) throw new Error('tool operation controls require a conversation session');
  return ctx.sessionId;
}

function output(record: ToolOperationRecord): ToolOperationControlOutput {
  return {
    operation_id: record.id,
    status: record.status,
    tool_name: record.toolName,
    result: record.result,
    error: record.error,
    side_effect_risk: record.sideEffectRisk,
    cancelled_by: record.cancelledBy,
  };
}

const OperationIdInputSchema = z.object({ operation_id: z.string().min(1).max(256) });

export const getToolOperationTool: DomainTool<
  z.infer<typeof OperationIdInputSchema>,
  ToolOperationControlOutput
> = {
  name: 'get_tool_operation',
  description: 'Poll one previously yielded tool operation owned by this conversation.',
  effect: 'read',
  inputSchema: OperationIdInputSchema,
  outputSchema: ToolOperationControlOutputSchema,
  costClass: 'local',
  async execute(ctx, input) {
    return output(
      await controlOwnedToolOperation(getProcessToolOperations(ctx.db), {
        action: 'get',
        operationId: input.operation_id,
        sessionId: owner(ctx),
        taskRunId: ctx.taskRunId,
        requestedBy: 'model',
      }),
    );
  },
  summarize(_input, result) {
    return `tool operation · ${result.status}`;
  },
  mirrorEvent: 'never',
};

const WaitToolOperationInputSchema = OperationIdInputSchema.extend({
  timeout_ms: z.number().int().min(0).max(SAFE_TOOL_OPERATION_WAIT_MAX_MS).default(0),
});

export const waitToolOperationTool: DomainTool<
  z.infer<typeof WaitToolOperationInputSchema>,
  ToolOperationControlOutput
> = {
  name: 'wait_tool_operation',
  description: 'Wait up to 5 seconds for one yielded tool operation owned by this conversation.',
  effect: 'read',
  inputSchema: WaitToolOperationInputSchema,
  outputSchema: ToolOperationControlOutputSchema,
  costClass: 'local',
  async execute(ctx, input) {
    return output(
      await controlOwnedToolOperation(getProcessToolOperations(ctx.db), {
        action: 'wait',
        operationId: input.operation_id,
        sessionId: owner(ctx),
        taskRunId: ctx.taskRunId,
        requestedBy: 'model',
        timeoutMs: input.timeout_ms,
      }),
    );
  },
  summarize(_input, result) {
    return `tool operation · ${result.status}`;
  },
  mirrorEvent: 'never',
};

export const cancelToolOperationTool: DomainTool<
  z.infer<typeof OperationIdInputSchema>,
  ToolOperationControlOutput
> = {
  name: 'cancel_tool_operation',
  description: 'Request cancellation of one yielded tool operation owned by this conversation.',
  effect: 'write',
  inputSchema: OperationIdInputSchema,
  outputSchema: ToolOperationControlOutputSchema,
  costClass: 'local',
  async execute(ctx, input) {
    return output(
      await controlOwnedToolOperation(getProcessToolOperations(ctx.db), {
        action: 'cancel',
        operationId: input.operation_id,
        sessionId: owner(ctx),
        taskRunId: ctx.taskRunId,
        requestedBy: 'model',
      }),
    );
  },
  summarize(_input, result) {
    return `tool operation · cancellation requested · ${result.status}`;
  },
  mirrorEvent: 'never',
};
