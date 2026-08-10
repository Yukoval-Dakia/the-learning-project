import type { SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { LifecycleUsage, ObservedRunUsage, TerminalResultEvidence } from './run-lifecycle';

type RawSdkUsage = {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
};

type ThinkingObservation = {
  blocks: number;
  characters: number;
};

type SdkUsageAccumulator = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

function emptyUsage(): SdkUsageAccumulator {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function accumulateUsage(usage: RawSdkUsage | undefined, aggregate: SdkUsageAccumulator): boolean {
  if (
    !usage ||
    ![
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_input_tokens,
      usage.cache_creation_input_tokens,
    ].some((value) => typeof value === 'number')
  ) {
    return false;
  }
  aggregate.inputTokens += usage.input_tokens ?? 0;
  aggregate.outputTokens += usage.output_tokens ?? 0;
  aggregate.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  aggregate.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
  return true;
}

function usageWithThinking(
  aggregate: SdkUsageAccumulator,
  thinking: ThinkingObservation,
): ObservedRunUsage {
  const usage: LifecycleUsage = {
    inputTokens: aggregate.inputTokens + aggregate.cacheReadTokens,
    outputTokens: aggregate.outputTokens,
    ...(thinking.blocks > 0
      ? { thinkingBlocks: thinking.blocks, thinkingCharacters: thinking.characters }
      : {}),
  };
  return {
    usage,
    tokenCounts: {
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      cacheReadTokens: aggregate.cacheReadTokens,
      cacheCreationTokens: aggregate.cacheCreationTokens,
    },
  };
}

export function createSdkTerminalEvidenceCollector(): Readonly<{
  observeAssistant(message: SDKAssistantMessage): ObservedRunUsage | undefined;
  fromResult(message: Extract<SDKMessage, { type: 'result' }>): TerminalResultEvidence;
}> {
  const thinking: ThinkingObservation = { blocks: 0, characters: 0 };
  const observedUsage = emptyUsage();

  return {
    observeAssistant(message) {
      for (const block of message.message.content ?? []) {
        if (block.type !== 'thinking') continue;
        thinking.blocks += 1;
        thinking.characters += typeof block.thinking === 'string' ? block.thinking.length : 0;
      }
      return accumulateUsage(message.message.usage, observedUsage)
        ? usageWithThinking(observedUsage, thinking)
        : undefined;
    },
    fromResult(message) {
      const terminalUsage = emptyUsage();
      const hasTerminalUsage = accumulateUsage(message.usage, terminalUsage);
      const aggregate = hasTerminalUsage ? terminalUsage : observedUsage;
      return {
        ...usageWithThinking(aggregate, thinking),
        costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined,
        finishReason:
          message.stop_reason ?? (message.subtype === 'success' ? 'stop' : message.subtype),
        structuredOutput: message.subtype === 'success' ? message.structured_output : undefined,
      };
    },
  };
}
