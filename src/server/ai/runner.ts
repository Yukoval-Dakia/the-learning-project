import { type TaskKind, tasks } from '@/ai/registry';
import type { Db } from '@/db/client';
import { anthropic } from '@ai-sdk/anthropic';
import { createId } from '@paralleldrive/cuid2';
import {
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  generateText,
  stepCountIs,
  streamText,
} from 'ai';
import type { R2Client } from '../r2';
import { writeCostLedger, writeToolCallLog } from './log';

export interface RunTaskCtx {
  db: Db;
  r2: R2Client;
  /** Override model for testing (defaults to anthropic provider with task's defaultModel). */
  model?: LanguageModel;
}

export interface RunTaskResult {
  task_run_id: string;
  text: string;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

const TASK_KINDS = Object.keys(tasks) as TaskKind[];

function isKnownTask(k: string): k is TaskKind {
  return (TASK_KINDS as string[]).includes(k);
}

export interface MultimodalTaskInput {
  text: string;
  images: Array<{ data: string | Uint8Array | ArrayBuffer | URL; mediaType: string }>;
}

function isMultimodalTaskInput(input: unknown): input is MultimodalTaskInput {
  if (input == null || typeof input !== 'object') return false;
  const candidate = input as { text?: unknown; images?: unknown };
  return (
    typeof candidate.text === 'string' &&
    Array.isArray(candidate.images) &&
    candidate.images.every((image) => {
      const img = image as { data?: unknown; mediaType?: unknown };
      return (
        img.data != null && typeof img.mediaType === 'string' && img.mediaType.startsWith('image/')
      );
    })
  );
}

function multimodalMessages(input: MultimodalTaskInput): ModelMessage[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: input.text },
        ...input.images.map((image) => ({
          type: 'image' as const,
          image: image.data,
          mediaType: image.mediaType,
        })),
      ],
    },
  ];
}

/**
 * Runs a registered task with a single-shot generateText call (no tools, no streaming).
 *
 * Records token usage to CostLedger; cost calc deferred (Phase 1 records 0).
 */
export async function runTask(
  kind: string,
  input: unknown,
  ctx: RunTaskCtx,
): Promise<RunTaskResult> {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];
  const model = ctx.model ?? anthropic(def.defaultModel);
  const taskRunId = createId();

  const baseOptions = {
    model,
    system: def.systemPrompt,
    abortSignal: AbortSignal.timeout(def.budget.timeout),
  };

  const result = isMultimodalTaskInput(input)
    ? await generateText({
        ...baseOptions,
        messages: multimodalMessages(input),
      })
    : await generateText({
        ...baseOptions,
        prompt: typeof input === 'string' ? input : JSON.stringify(input),
      });

  await writeCostLedger(ctx.db, {
    task_kind: kind,
    provider: def.defaultProvider,
    model: def.defaultModel,
    cost: 0, // Phase 1: just record tokens; cost calc deferred.
    tokens_in: result.usage.inputTokens ?? 0,
    tokens_out: result.usage.outputTokens ?? 0,
  });

  return {
    task_run_id: taskRunId,
    text: result.text,
    finishReason: result.finishReason,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
  };
}

export interface StreamTaskCtx extends RunTaskCtx {
  /** Tools the model may call. tool-calling loop is bounded by task budget.maxIterations. */
  tools?: ToolSet;
}

/**
 * Stream a task with tool-calling loop. Returns a Response with a streaming body
 * (UTF-8 text deltas via toTextStreamResponse). Per-step tool calls are persisted
 * to ToolCallLog; final aggregated usage is persisted to CostLedger.
 *
 * The caller is responsible for piping the body to the client.
 */
export function streamTask(kind: string, input: unknown, ctx: StreamTaskCtx): Response {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];
  const model = ctx.model ?? anthropic(def.defaultModel);
  const taskRunId = createId();
  let iteration = 0;
  let stepStartTime = Date.now();

  const result = streamText({
    model,
    system: def.systemPrompt,
    prompt: typeof input === 'string' ? input : JSON.stringify(input),
    tools: ctx.tools,
    stopWhen: stepCountIs(def.budget.maxIterations),
    abortSignal: AbortSignal.timeout(def.budget.timeout),
    onStepFinish: async ({ toolCalls, toolResults }) => {
      iteration += 1;
      const stepLatencyMs = Date.now() - stepStartTime;
      const resultsById = new Map((toolResults ?? []).map((tr) => [tr.toolCallId, tr]));
      for (const tc of toolCalls) {
        const tr = resultsById.get(tc.toolCallId);
        await writeToolCallLog(ctx.db, {
          task_run_id: taskRunId,
          task_kind: kind,
          tool_name: tc.toolName,
          input_json: tc.input ?? {},
          output_json: tr ?? {},
          iteration,
          latency_ms: stepLatencyMs,
          cost: 0,
        });
      }
      stepStartTime = Date.now();
    },
    onFinish: async ({ totalUsage }) => {
      await writeCostLedger(ctx.db, {
        task_kind: kind,
        provider: def.defaultProvider,
        model: def.defaultModel,
        cost: 0, // Phase 1: just record tokens; cost calc deferred.
        tokens_in: totalUsage?.inputTokens ?? 0,
        tokens_out: totalUsage?.outputTokens ?? 0,
      });
    },
  });

  return result.toTextStreamResponse();
}
