import { DBOS } from '@dbos-inc/dbos-sdk';
import { type AgentTool, type StreamFn, runAgentLoop } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  type Model,
  Type,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { z } from 'zod';
import {
  type GateSql,
  arrangeNext,
  arrangeSchema,
  digest,
  readSnapshot,
  receiptSchema,
} from '@/capabilities/practice/testing/pi-dbos-gate/operations';
import { modelCommand } from './fixture';

export const jobSchema = z
  .object({
    workflowId: z.string(),
    learnerId: z.string(),
    validUntil: z.iso.datetime(),
    timestamp: z.number().int(),
    entry: z.enum(['pi', 'background']),
  })
  .strict();
export type GateJob = z.infer<typeof jobSchema>;
export type Boundary = 'model-returned' | 'model-saved' | 'tool-committed' | 'tool-receipt-saved';
export type Barrier = (boundary: Boundary, turn: number) => Promise<void>;

const controlledModel: Model<'openai-completions'> = {
  id: 'gate-fixture',
  name: 'Controlled gate fixture',
  api: 'openai-completions',
  provider: 'gate-controlled',
  baseUrl: 'http://invalid.test',
  reasoning: false,
  input: ['text'],
  contextWindow: 32000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  timestamp: number,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    stopReason,
    timestamp,
    api: 'openai-completions',
    provider: 'gate-controlled',
    model: 'gate-fixture',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export function registerGateWorkflow(sql: GateSql, barrier: Barrier) {
  return DBOS.registerWorkflow(
    async (job: GateJob) => {
      const snapshot = await DBOS.runStep(() => readSnapshot(sql, job.learnerId), {
        name: 'read-state',
      });
      if (job.entry === 'background') {
        const command = modelCommand(snapshot, `${job.workflowId}:arrange:0`, job.validUntil);
        return {
          snapshotVersion: snapshot.version,
          receipt: await DBOS.runStep(() => arrangeNext(sql, command), {
            name: 'background-arrange',
          }),
        };
      }
      let turn = 0;
      const streamFn: StreamFn = async (_model, transcript) => {
        const currentTurn = turn++;
        const response = await DBOS.runStep(
          async () => {
            const command = modelCommand(snapshot, `${job.workflowId}:arrange:0`, job.validUntil);
            const message =
              currentTurn === 0
                ? assistant(
                    [
                      {
                        type: 'toolCall',
                        id: 'arrange:0',
                        name: 'arrange_next',
                        arguments: command,
                      },
                    ],
                    'toolUse',
                    job.timestamp,
                  )
                : assistant(
                    [
                      {
                        type: 'text',
                        text: '已按工具的持久回执结束；被拒结果不会重试覆盖新状态。',
                      },
                    ],
                    'stop',
                    job.timestamp,
                  );
            // Separate controlled-provider observer. This is never read as a recovery checkpoint.
            await sql`insert into yuk1338.model_attempt (workflow_id, turn, input_digest, response)
          values (${job.workflowId}, ${currentTurn}, ${digest(transcript)}, ${sql.json(z.json().parse(message))})`;
            await barrier('model-returned', currentTurn);
            return message;
          },
          { name: `model-response-${currentTurn}`, retriesAllowed: false },
        );
        await barrier('model-saved', currentTurn);
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: 'done',
          reason: response.stopReason === 'toolUse' ? 'toolUse' : 'stop',
          message: response,
        });
        return stream;
      };
      const parameters = Type.Object(
        {
          learnerId: Type.String(),
          operationId: Type.String(),
          expectedVersion: Type.Integer(),
          validUntil: Type.String(),
          nextActivity: Type.Union([
            Type.Literal('ellipse-transfer'),
            Type.Literal('ellipse-supported-review'),
          ]),
          rationale: Type.String(),
        },
        { additionalProperties: false },
      );
      const tool: AgentTool<typeof parameters> = {
        name: 'arrange_next',
        label: 'Arrange next activity',
        description: 'Apply a version-fenced arrangement.',
        parameters,
        executionMode: 'sequential',
        replay: 'safe',
        execute: async (toolCallId, input) => {
          const command = arrangeSchema.parse(input);
          if (
            command.learnerId !== job.learnerId ||
            command.operationId !== `${job.workflowId}:${toolCallId}` ||
            command.expectedVersion !== snapshot.version
          ) {
            throw new Error('Tool identity or snapshot mismatch');
          }
          await DBOS.runStep(
            async () => {
              const receipt = await arrangeNext(sql, command);
              await barrier('tool-committed', 0);
              return receipt;
            },
            { name: `business-commit-${toolCallId}`, retriesAllowed: false },
          );
          const receipt = await DBOS.runStep(
            async () => {
              const [row] =
                await sql`select result from yuk1338.receipt where operation_id = ${command.operationId}`;
              return receiptSchema.parse(row?.result);
            },
            { name: `tool-receipt-${toolCallId}` },
          );
          await barrier('tool-receipt-saved', 0);
          return {
            content: [{ type: 'text', text: JSON.stringify(receipt) }],
            details: receipt,
            isError: receipt.kind === 'rejected',
          };
        },
      };
      const messages = await runAgentLoop(
        [{ role: 'user', content: JSON.stringify(snapshot), timestamp: job.timestamp }],
        { messages: [], tools: [tool] },
        {
          model: controlledModel,
          convertToLlm: (messages) => messages,
          toolExecution: 'sequential',
        },
        () => {},
        undefined,
        streamFn,
      );
      return { snapshotVersion: snapshot.version, messages };
    },
    { name: 'yuk1338-pi-loop', inputSchema: z.tuple([jobSchema]) },
  );
}
