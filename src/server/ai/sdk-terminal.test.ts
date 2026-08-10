import type { SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createSdkTerminalEvidenceCollector } from './sdk-terminal';

type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
type ResultUsage = ResultMessage['usage'];

function usage(values: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheCreation?: number;
}): ResultUsage {
  return {
    input_tokens: values.input,
    output_tokens: values.output,
    cache_read_input_tokens: values.cacheRead ?? 0,
    cache_creation_input_tokens: values.cacheCreation ?? 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    fallback_credit: { status: { type: 'not_applied', reason: 'not_enabled' } },
    inference_geo: 'test',
    iterations: [],
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  };
}

function assistant(
  content: SDKAssistantMessage['message']['content'],
  observedUsage: SDKAssistantMessage['message']['usage'] = usage({ input: 0, output: 0 }),
): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_terminal_test',
      container: null,
      content,
      context_management: null,
      diagnostics: null,
      model: 'test-model',
      role: 'assistant',
      stop_details: null,
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: observedUsage,
    },
    parent_tool_use_id: null,
    uuid: 'assistant-terminal-test',
    session_id: 'session-terminal-test',
  };
}

function successResult(
  overrides: {
    readonly usage?: ResultUsage;
    readonly totalCostUsd?: number;
    readonly stopReason?: string | null;
    readonly structuredOutput?: unknown;
  } = {},
): ResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: overrides.stopReason === undefined ? 'end_turn' : overrides.stopReason,
    total_cost_usd: overrides.totalCostUsd ?? 0,
    usage: overrides.usage ?? usage({ input: 0, output: 0 }),
    modelUsage: {},
    permission_denials: [],
    structured_output: overrides.structuredOutput,
    uuid: 'result-terminal-test',
    session_id: 'session-terminal-test',
  };
}

function errorResult(stopReason: string | null = null): ResultMessage {
  return {
    type: 'result',
    subtype: 'error_max_turns',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: true,
    num_turns: 1,
    stop_reason: stopReason,
    total_cost_usd: 0.25,
    usage: usage({ input: 3, output: 4 }),
    modelUsage: {},
    permission_denials: [],
    errors: ['terminal failure'],
    uuid: 'result-terminal-error-test',
    session_id: 'session-terminal-test',
  };
}

describe('createSdkTerminalEvidenceCollector', () => {
  it('uses authoritative success usage, cache counts, zero cost, stop reason, and output', () => {
    const collector = createSdkTerminalEvidenceCollector();

    collector.observeAssistant(
      assistant(
        [{ type: 'text', text: 'visible', citations: null }],
        usage({ input: 90, output: 80 }),
      ),
    );
    const evidence = collector.fromResult(
      successResult({
        usage: usage({ input: 10, output: 7, cacheRead: 4, cacheCreation: 2 }),
        totalCostUsd: 0,
        stopReason: null,
        structuredOutput: { answer: 42 },
      }),
    );

    expect(evidence).toEqual({
      usage: { inputTokens: 14, outputTokens: 7 },
      tokenCounts: {
        inputTokens: 10,
        outputTokens: 7,
        cacheReadTokens: 4,
        cacheCreationTokens: 2,
      },
      costUsd: 0,
      finishReason: 'stop',
      structuredOutput: { answer: 42 },
    });
  });

  it('uses the error subtype when stop reason is absent and drops structured output', () => {
    const collector = createSdkTerminalEvidenceCollector();
    const message = errorResult();
    Reflect.set(message, 'structured_output', { mustNotEscape: true });

    expect(collector.fromResult(message)).toEqual({
      usage: { inputTokens: 3, outputTokens: 4 },
      tokenCounts: {
        inputTokens: 3,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      costUsd: 0.25,
      finishReason: 'error_max_turns',
      structuredOutput: undefined,
    });
  });

  it('accumulates assistant usage and thinking metadata without retaining raw thinking', () => {
    const collector = createSdkTerminalEvidenceCollector();

    const first = collector.observeAssistant(
      assistant(
        [{ type: 'thinking', thinking: 'private-alpha', signature: 'sig-a' }],
        usage({ input: 2, output: 3, cacheRead: 5, cacheCreation: 7 }),
      ),
    );
    const second = collector.observeAssistant(
      assistant(
        [{ type: 'thinking', thinking: 'private-beta', signature: 'sig-b' }],
        usage({ input: 11, output: 13, cacheRead: 17, cacheCreation: 19 }),
      ),
    );

    expect(first).toEqual({
      usage: { inputTokens: 7, outputTokens: 3, thinkingBlocks: 1, thinkingCharacters: 13 },
      tokenCounts: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 5,
        cacheCreationTokens: 7,
      },
    });
    expect(second).toEqual({
      usage: { inputTokens: 35, outputTokens: 16, thinkingBlocks: 2, thinkingCharacters: 25 },
      tokenCounts: {
        inputTokens: 13,
        outputTokens: 16,
        cacheReadTokens: 22,
        cacheCreationTokens: 26,
      },
    });
    expect(JSON.stringify(second)).not.toContain('private-alpha');
    expect(JSON.stringify(second)).not.toContain('private-beta');
  });

  it('falls back to accumulated assistant usage only when result usage is absent', () => {
    const collector = createSdkTerminalEvidenceCollector();
    collector.observeAssistant(
      assistant([], usage({ input: 5, output: 7, cacheRead: 11, cacheCreation: 13 })),
    );
    const withoutUsage = successResult();
    Reflect.deleteProperty(withoutUsage, 'usage');

    expect(collector.fromResult(withoutUsage)).toMatchObject({
      usage: { inputTokens: 16, outputTokens: 7 },
      tokenCounts: {
        inputTokens: 5,
        outputTokens: 7,
        cacheReadTokens: 11,
        cacheCreationTokens: 13,
      },
    });
  });

  it('returns no observed usage for an assistant without usage but retains thinking', () => {
    const collector = createSdkTerminalEvidenceCollector();
    const message = assistant([
      { type: 'thinking', thinking: 'private-survives', signature: 'sig-c' },
    ]);
    Reflect.deleteProperty(message.message, 'usage');

    expect(collector.observeAssistant(message)).toBeUndefined();
    const result = successResult();
    Reflect.deleteProperty(result, 'usage');
    expect(collector.fromResult(result).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      thinkingBlocks: 1,
      thinkingCharacters: 16,
    });
  });
});
