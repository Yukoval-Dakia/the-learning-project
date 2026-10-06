import { type AgentTool, agentLoop } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  type Model,
  Type,
  createAssistantMessageEventStream,
  createModels,
} from '@earendil-works/pi-ai';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExecutionAdapterStartupArgs } from './execution-adapter';
import { __setTraceExporterForTests, traceOperation } from './laminar-tracing';
import { memoryTraceExporter, traceField } from './laminar-tracing.test-support';
import { PiAgentAdapter } from './pi-agent-adapter';

const model: Model<'openai-completions'> = {
  id: 'offline-model',
  name: 'Offline',
  provider: 'opencode-go',
  api: 'openai-completions',
  reasoning: false,
  baseUrl: 'https://offline.invalid',
  input: ['text'],
  contextWindow: 10000,
  maxTokens: 100,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
};
function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 1,
    usage: {
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
    stopReason,
  };
}
function setup(
  messages: AssistantMessage[],
  tool: AgentTool,
  overrides: Partial<ExecutionAdapterStartupArgs> = {},
) {
  const { records, exporter } = memoryTraceExporter();
  __setTraceExporterForTests(exporter);
  const models = createModels();
  vi.spyOn(models, 'getModel').mockReturnValue(model);
  const streamSimple = vi.spyOn(models, 'streamSimple').mockImplementation(() => {
    const message = messages.shift();
    if (!message) throw new Error('offline script exhausted');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      stream.push({ type: 'error', reason: message.stopReason, error: message });
    else if (message.stopReason === 'pending') throw new Error('unsupported offline script stop');
    else stream.push({ type: 'done', reason: message.stopReason, message });
    return stream;
  });
  const controller = new AbortController();
  const args: ExecutionAdapterStartupArgs = {
    kind: 'CopilotTask',
    runId: 'synthetic-attempt',
    initializeTimeoutMs: 1000,
    resolved: {
      provider: 'opencode-go',
      model: model.id,
      apiKey: 'SECRET_KEY_SENTINEL',
      authMode: 'key',
    },
    options: { abortController: controller, systemPrompt: 'SECRET_SYSTEM_SENTINEL' },
    piToolMounts: [{ type: 'custom', tools: [tool] }],
    ...overrides,
  };
  const adapter = new PiAgentAdapter({ models, agentLoop });
  return { records, exporter, controller, streamSimple, adapter, args };
}
const call = (
  id: string,
  name: string,
  args: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>['arguments'],
) =>
  assistant(
    [
      { type: 'thinking', thinking: 'SECRET_COT_SENTINEL' },
      { type: 'toolCall', id, name, arguments: args },
    ],
    'toolUse',
  );
const final = () => assistant([{ type: 'text', text: 'SECRET_FINAL_SENTINEL' }]);
function tool(execute: AgentTool['execute']): AgentTool {
  return {
    name: 'mcp__loom__fixture',
    label: 'Fixture',
    description: 'Fixture',
    parameters: Type.Object({ query: Type.String() }),
    execute,
  };
}
afterEach(() => {
  __setTraceExporterForTests();
  vi.restoreAllMocks();
});

it.each(['success', 'throw', 'isError', 'blocked'])(
  'traces one tool execution or a pre-execute attempt: %s',
  async (outcome) => {
    const order: string[] = [];
    const execute = vi.fn<AgentTool['execute']>(async (_id, args, signal, onUpdate) => {
      order.push('execute');
      expect(args).toEqual({ query: 'SECRET_ARGS_SENTINEL' });
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(onUpdate).toBeTypeOf('function');
      onUpdate?.({ content: [{ type: 'text', text: 'SECRET_UPDATE_SENTINEL' }], details: {} });
      if (outcome === 'throw') throw new Error('SECRET_EXCEPTION_SENTINEL');
      return {
        content: [{ type: 'text', text: 'SECRET_TOOL_OUTPUT_SENTINEL' }],
        details: { arbitrary: 'SECRET_DETAILS_SENTINEL' },
        isError: outcome === 'isError',
      };
    });
    const fixture = setup(
      [call('call-fixture', 'mcp__loom__fixture', { query: 'SECRET_ARGS_SENTINEL' }), final()],
      tool(execute),
      {
        piHooks: {
          beforeToolCall: [
            () => {
              order.push('before');
              return outcome === 'blocked'
                ? { block: true, reason: 'SECRET_BLOCK_SENTINEL' }
                : undefined;
            },
          ],
          afterToolCall: [
            () => {
              order.push('after');
            },
          ],
        },
      },
    );
    await traceOperation('task.run', { task_run_id: 'synthetic-attempt' }, async () => {
      const prepared = await fixture.adapter.startup(fixture.args);
      // Creation and delayed iteration occur under the enclosing task context.
      const query = prepared.query('SECRET_PROMPT_SENTINEL');
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      const frames = [];
      for await (const frame of query) frames.push(frame);
      await prepared.close();
      expect(frames.at(-1)?.type).toBe('result');
    });
    expect(execute).toHaveBeenCalledTimes(outcome === 'blocked' ? 0 : 1);
    expect(order).toEqual(outcome === 'blocked' ? ['before'] : ['before', 'execute', 'after']);
    const toolSpans = fixture.records.filter((record) => record.type === 'TOOL');
    expect(toolSpans).toHaveLength(1);
    expect(toolSpans[0].name).toBe(outcome === 'blocked' ? 'tool.attempt' : 'tool.execute');
    expect(toolSpans[0].attributes[traceField('executed')]).toBe(outcome !== 'blocked');
    expect(toolSpans[0].status).toBe(outcome === 'success' ? 1 : 2);
    expect(fixture.records.filter((record) => record.type === 'LLM')).toHaveLength(2);
    expect(fixture.records.every((record) => record.ends === 1)).toBe(true);
    expect(
      fixture.records.slice(1).every((record) => record.parent === fixture.records[0].context),
    ).toBe(true);
    expect(JSON.stringify(fixture.records)).not.toContain('SENTINEL');
  },
);

it('propagates parent context through spawn and child loops without duplicate tools or usage totals', async () => {
  const execute = vi.fn<AgentTool['execute']>(async () => ({
    content: [{ type: 'text', text: 'tool result' }],
    details: {},
  }));
  const fixture = setup(
    [
      call('spawn-child', 'Task', {
        subagent_type: 'helper',
        description: 'SECRET_DESCRIPTION_SENTINEL',
        prompt: 'SECRET_CHILD_PROMPT_SENTINEL',
      }),
      call('child-tool', 'mcp__loom__fixture', { query: 'child lookup' }),
      final(),
      final(),
    ],
    tool(execute),
    {
      piAgents: {
        helper: {
          prompt: 'SECRET_CHILD_SYSTEM_SENTINEL',
          description: 'Helper',
          tools: ['mcp__loom__fixture'],
        },
      },
    },
  );
  await traceOperation('task.run', {}, async () => {
    const prepared = await fixture.adapter.startup(fixture.args);
    for await (const _frame of prepared.query('root prompt')) {
      /* Consume one invocation. */
    }
    await prepared.close();
  });
  const spawn = fixture.records.find(
    (record) =>
      record.name === 'tool.execute' &&
      record.attributes[traceField('tool_call_id')] === 'spawn-child',
  );
  const child = fixture.records.find((record) => record.name === 'agent.child');
  const childTool = fixture.records.find(
    (record) =>
      record.name === 'tool.execute' &&
      record.attributes[traceField('tool_call_id')] === 'child-tool',
  );
  expect(child?.parent).toBe(spawn?.context);
  expect(childTool?.parent).toBe(child?.context);
  expect(execute).toHaveBeenCalledOnce();
  expect(fixture.records.filter((record) => record.name === 'tool.execute')).toHaveLength(2);
  expect(fixture.records.filter((record) => record.name === 'tool.attempt')).toHaveLength(0);
  const llms = fixture.records.filter((record) => record.name === 'llm.call');
  expect(llms).toHaveLength(4);
  expect(llms.filter((record) => record.parent === child?.context)).toHaveLength(2);
  expect(llms.every((record) => record.attributes[traceField('additive_usage')] === true)).toBe(
    true,
  );
  expect(
    fixture.records
      .filter((record) => record.name !== 'llm.call')
      .every((record) => record.attributes['gen_ai.usage.cost'] === undefined),
  ).toBe(true);
  expect(fixture.records.every((record) => record.ends === 1)).toBe(true);
  expect(JSON.stringify(fixture.records)).not.toContain('SENTINEL');
});

it('keeps business model/tool call counts and frames when every exporter operation fails', async () => {
  const execute = vi.fn<AgentTool['execute']>(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    details: {},
  }));
  const fixture = setup(
    [call('call', 'mcp__loom__fixture', { query: 'lookup' }), final()],
    tool(execute),
  );
  __setTraceExporterForTests({
    start: () => {
      throw new Error('exporter unavailable');
    },
    flush: fixture.exporter.flush,
  });
  const prepared = await fixture.adapter.startup(fixture.args);
  const frames = [];
  for await (const frame of prepared.query('prompt')) frames.push(frame);
  await prepared.close();
  expect(execute).toHaveBeenCalledOnce();
  expect(fixture.streamSimple).toHaveBeenCalledTimes(2);
  const terminal = frames.at(-1);
  expect(terminal?.type).toBe('result');
  if (terminal?.type === 'result') expect(terminal.subtype).toBe('success');
});
