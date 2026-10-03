// Exercise the installed pi 1.0 engine; only the provider response stream is scripted.

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
  Type,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionAdapterStartupArgs, RunnerMessage } from './execution-adapter';
import { PiAgentAdapter } from './pi-agent-adapter';
import { createLoomPiModels } from './pi-models';

function response(model: Model<Api>, over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'Evidence-backed answer.' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: 'stop',
    timestamp: 1,
    usage: {
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 125,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
    ...over,
  };
}

const toolCall = (name: string, args = {}) => ({
  type: 'toolCall' as const,
  id: `call_${name}`,
  name,
  arguments: args,
});

async function harness(
  script: (
    model: Model<Api>,
    context: TranscriptContext,
    request: number,
  ) => Partial<AssistantMessage>,
) {
  const models = await createLoomPiModels();
  const model = models.getModel('xiaomi', 'mimo-v2.5-pro');
  if (!model) throw new Error('Expected configured MiMo catalog model');
  model.contextWindow = 32768;
  const requests: TranscriptContext[] = [];
  const stream = vi.spyOn(models, 'streamSimple').mockImplementation((model, context) => {
    // Capture immutable request evidence before the loop appends later results.
    requests.push(structuredClone(context) as TranscriptContext);
    const result = response(model, script(model, context as TranscriptContext, requests.length));
    const events = createAssistantMessageEventStream();
    events.push({ type: 'start', partial: result });
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
      events.push({ type: 'error', reason: result.stopReason, error: result });
    } else if (result.stopReason !== 'pending') {
      events.push({ type: 'done', reason: result.stopReason, message: result });
    }
    return events;
  });
  const execute = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'Source A: verified finding.' }],
    details: null,
  }));
  const tool: AgentTool = {
    name: 'mcp__loom__lookup',
    label: 'lookup',
    description: 'Retrieve grounded evidence',
    parameters: Type.Object({}),
    execute,
  };
  const args: ExecutionAdapterStartupArgs = {
    kind: 'AttributionTask',
    runId: 'pi-1-contract',
    initializeTimeoutMs: 5000,
    resolved: {
      provider: 'xiaomi',
      authMode: 'key',
      apiKey: 'test-key-never-sent',
      model: 'mimo-v2.5-pro',
    },
    options: { systemPrompt: 'Preserve source identity and distinguish uncertainty.', maxTurns: 2 },
    piToolMounts: [{ type: 'custom', tools: [tool] }],
  };
  const adapter = new PiAgentAdapter({ models });
  const run = async () => {
    const prepared = await adapter.startup(args);
    const frames: RunnerMessage[] = [];
    try {
      for await (const frame of prepared.query('Explain this multi-step result.'))
        frames.push(frame);
    } finally {
      await prepared.close();
    }
    return frames;
  };
  return { args, run, adapter, execute, requests, stream, models };
}

describe('pi 1.0 installed agentLoop contract', () => {
  it('preserves instructions, skill text, replay and tool declarations through a real two-request loop', async () => {
    const h = await harness((_model, _context, n) =>
      n === 1 ? { content: [toolCall('mcp__loom__lookup')], stopReason: 'toolUse' } : {},
    );
    h.args.piSkillDocs = [
      { name: 'reasoning', body: 'Cite source A; acknowledge missing premises.' },
    ];
    h.args.piSessionReplay = [
      { role: 'user', text: 'Historical question' },
      { role: 'assistant', text: 'Historical answer' },
    ];
    const frames = await h.run();
    expect(h.requests).toHaveLength(2);
    expect(h.execute).toHaveBeenCalledTimes(1);
    for (const request of h.requests) {
      expect(getCurrentSystemPrompt(request.messages)).toContain('Preserve source identity');
      expect(getCurrentSystemPrompt(request.messages)).toContain(
        'Cite source A; acknowledge missing premises.',
      );
      expect(getCurrentTools(request.messages).map((t) => t.name)).toEqual(['mcp__loom__lookup']);
      expect(request.messages).toContainEqual(
        expect.objectContaining({ role: 'user', content: 'Historical question' }),
      );
    }
    expect(h.requests[1].messages).toContainEqual(
      expect.objectContaining({
        role: 'toolResult',
        toolName: 'mcp__loom__lookup',
        isError: false,
      }),
    );
    expect(frames.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      num_turns: 2,
      usage: { input_tokens: 200, output_tokens: 40 },
    });
  });

  it('caps after executing the last tool batch, before another request or queue poll', async () => {
    const h = await harness(() => ({
      content: [toolCall('mcp__loom__lookup')],
      stopReason: 'toolUse',
    }));
    const followup = vi.fn(async () => [
      { role: 'user' as const, content: 'Do more', timestamp: 1 },
    ]);
    h.args.piQueues = { getFollowUpMessages: followup };
    const frames = await h.run();
    expect(h.requests).toHaveLength(2);
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(followup).not.toHaveBeenCalled();
    expect(frames.at(-1)).toMatchObject({ subtype: 'error_max_turns', is_error: true });
  });

  it('finishes cleanly at maxTurns=1 and leaves follow-ups queued', async () => {
    const h = await harness(() => ({}));
    h.args.options.maxTurns = 1;
    const followup = vi.fn(async () => [
      { role: 'user' as const, content: 'Do more', timestamp: 1 },
    ]);
    h.args.piQueues = { getFollowUpMessages: followup };
    const frames = await h.run();
    expect(h.requests).toHaveLength(1);
    expect(followup).not.toHaveBeenCalled();
    expect(frames.at(-1)).toMatchObject({ subtype: 'success', is_error: false });
  });

  it('allows a follow-up below the ceiling without an extra forced continuation', async () => {
    const h = await harness(() => ({}));
    const followup = vi.fn(async () => [
      { role: 'user' as const, content: 'One clarification', timestamp: 1 },
    ]);
    h.args.piQueues = { getFollowUpMessages: followup };
    expect((await h.run()).at(-1)).toMatchObject({ subtype: 'success' });
    expect(h.requests).toHaveLength(2);
    expect(followup).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'aborted'] as const)(
    'preserves provider %s at the ceiling without executing partial tool calls',
    async (stopReason) => {
      const h = await harness(() => ({
        stopReason,
        content: [toolCall('mcp__loom__lookup')],
        errorMessage: 'upstream failure',
      }));
      h.args.options.maxTurns = 1;
      expect((await h.run()).at(-1)).toMatchObject({
        subtype: 'error_during_execution',
        is_error: true,
      });
      expect(h.requests).toHaveLength(1);
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it('caller abort suppresses the terminal frame and any next request', async () => {
    const abort = new AbortController();
    const h = await harness(() => {
      abort.abort();
      return { stopReason: 'aborted', errorMessage: 'cancelled' };
    });
    h.args.options.abortController = abort;
    const frames = await h.run();
    expect(h.requests).toHaveLength(1);
    expect(frames.some((f) => f.type === 'result')).toBe(false);
  });

  it.each([false, true])(
    'runs a real nested loop with clean/capped child (capped=%s)',
    async (capped) => {
      let rootRequests = 0;
      let childRequests = 0;
      const h = await harness((_model, context) => {
        if (getCurrentSystemPrompt(context.messages) === 'Scout: produce a grounded report.') {
          childRequests++;
          return capped
            ? { content: [toolCall('mcp__loom__lookup')], stopReason: 'toolUse' }
            : { content: [{ type: 'text', text: 'Grounded child report.' }] };
        }
        rootRequests++;
        return rootRequests === 1
          ? {
              content: [
                toolCall('Task', {
                  subagent_type: 'scout',
                  description: 'Inspect sources',
                  prompt: 'Read source A and check conflicting assumptions.',
                }),
              ],
              stopReason: 'toolUse',
            }
          : {};
      });
      h.args.piAgents = {
        scout: {
          description: 'Grounding scout',
          prompt: 'Scout: produce a grounded report.',
          tools: ['mcp__loom__lookup'],
          maxTurns: 1,
        },
      };
      const frames = await h.run();
      expect(rootRequests).toBe(2);
      expect(childRequests).toBe(1);
      expect(h.requests).toHaveLength(3);
      const childRequest = h.requests.find((r) =>
        getCurrentSystemPrompt(r.messages).startsWith('Scout:'),
      );
      expect(getCurrentTools(childRequest?.messages ?? []).map((t) => t.name)).toEqual([
        'mcp__loom__lookup',
      ]);
      expect(frames).toContainEqual(
        expect.objectContaining({
          subtype: 'task_updated',
          patch: expect.objectContaining({ status: capped ? 'failed' : 'completed' }),
        }),
      );
      expect(frames.at(-1)).toMatchObject({
        subtype: 'success',
        usage: { input_tokens: 300, output_tokens: 60 },
      });
    },
  );

  it('retains system instructions and executable tool declarations after compaction', async () => {
    const h = await harness(() => ({}));
    h.args.nativeCompaction = { sessionContext: 'Bounded learner context.' };
    h.args.piSessionReplay = [
      { role: 'user', text: 'Old narrative. '.repeat(16_000) },
      { role: 'assistant', text: 'Recent concise evidence.' },
    ];
    const frames = await h.run();
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0];
    expect(getCurrentSystemPrompt(request.messages)).toBe(h.args.options.systemPrompt);
    expect(getCurrentTools(request.messages).map((t) => t.name)).toEqual(['mcp__loom__lookup']);
    expect(request.messages).toContainEqual(
      expect.objectContaining({ role: 'user', content: 'Bounded learner context.' }),
    );
    expect(
      request.messages.some(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.startsWith('Old narrative.'),
      ),
    ).toBe(false);
    expect(frames).toContainEqual(expect.objectContaining({ subtype: 'compact_boundary' }));
  });
});

describe('pi 1.0 Anthropic-compatible HTTP transport', () => {
  it('sends system/skill/tools and tool results on the primary MiMo wire, with two counted requests', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, reply) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      bodies.push(JSON.parse(body));
      const tool = bodies.length === 1;
      const events = [
        {
          type: 'message_start',
          message: {
            id: `msg_${bodies.length}`,
            type: 'message',
            role: 'assistant',
            model: 'mimo-v2.5-pro',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 13, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: tool
            ? { type: 'tool_use', id: 'lookup_wire', name: 'mcp__loom__lookup', input: {} }
            : { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: tool
            ? { type: 'input_json_delta', partial_json: '{}' }
            : { type: 'text_delta', text: 'Grounded final answer.' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: 7 },
        },
        { type: 'message_stop' },
      ];
      reply.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const h = await harness(() => ({}));
      h.stream.mockRestore(); // Real pi provider and HTTP client, not the scripted stream seam.
      const model = h.models.getModel('xiaomi', 'mimo-v2.5-pro');
      if (!model) throw new Error('Missing primary model');
      model.baseUrl = `http://127.0.0.1:${address.port}`;
      h.args.piSkillDocs = [{ name: 'wire-check', body: 'Verify source identity.' }];
      const frames = await h.run();
      expect(bodies).toHaveLength(2);
      expect(h.execute).toHaveBeenCalledTimes(1);
      for (const body of bodies) {
        expect(JSON.stringify(body.system)).toContain('Preserve source identity');
        expect(JSON.stringify(body.system)).toContain('Verify source identity.');
        expect(body.tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'mcp__loom__lookup',
              input_schema: expect.objectContaining({ type: 'object' }),
            }),
          ]),
        );
      }
      expect(JSON.stringify(bodies[1].messages)).toContain('Source A: verified finding.');
      expect(frames.at(-1)).toMatchObject({
        subtype: 'success',
        result: 'Grounded final answer.',
        usage: { input_tokens: 26, output_tokens: 14 },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
