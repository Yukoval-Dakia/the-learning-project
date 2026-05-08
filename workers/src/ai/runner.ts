import { anthropic } from '@ai-sdk/anthropic';
import { generateText, type LanguageModel } from 'ai';
import { createId } from '@paralleldrive/cuid2';
import { tasks, type TaskKind } from '../../../src/ai/registry';
import { writeCostLedger } from './log';
import type { Bindings } from '../types';

export interface RunTaskCtx {
  env: Bindings;
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

/**
 * Runs a registered task with a single-shot generateText call (no tools, no streaming).
 * Streaming + tool-calling come in later tasks (Task 7+).
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

  const result = await generateText({
    model,
    system: def.systemPrompt,
    prompt: typeof input === 'string' ? input : JSON.stringify(input),
    abortSignal: AbortSignal.timeout(def.budget.timeout),
  });

  await writeCostLedger(ctx.env.DB, {
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
