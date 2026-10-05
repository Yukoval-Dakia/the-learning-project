// YUK-1027 — openai/gpt-6-astra wire-contract test. The REAL pi-ai 0.85.1
// Responses driver (createLoomPiModels → builtin 'openai' provider →
// openai-responses api) runs against an injected fetch that captures the
// outbound Request and returns a scripted SSE body — no network, no key.
// This is the isolated-binding evidence the P1 spec asks for before the
// formal capability binding: /v1/responses URL, effort mapping, absence of
// unsupported sampling params, text/image/tool_call round-trips, foreign
// signature stripping, cache-bucket usage, and abort propagation.
//
// Pure no-DB unit: imports ./pi-models (dynamic @earendil-works/pi-ai
// imports only — no @/db, no network). MUST be enumerated in
// fastTestInclude (vitest.shared.ts): src/server/ai/** has no unit glob.

import type {
  AssistantMessage,
  Context,
  Api as PiApi,
  Model as PiModel,
  Tool,
  Usage,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { createLoomPiModels } from './pi-models';

const ASTRA_ID = 'gpt-6-astra';
const API_KEY = 'sk-contract-test';

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | null;
};

/** Scripted-SSE fake fetch: records the request, returns the event stream. */
function fakeFetch(sse: string, requests: CapturedRequest[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const rawBody = init?.body ?? request.body;
    const bodyText = typeof rawBody === 'string' ? rawBody : await request.text();
    requests.push({
      url: request.url,
      method: request.method,
      headers,
      body: JSON.parse(bodyText) as Record<string, unknown>,
      signal: init?.signal ?? request.signal,
    });
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

function sse(events: Record<string, unknown>[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

function messageItem(id: string, text: string): Record<string, unknown> {
  return {
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function usage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 10 },
    total_tokens: 1050,
    ...over,
  };
}

function textResponseSse(text: string, usageOver: Record<string, unknown> = {}): string {
  const item = messageItem('msg_contract_1', text);
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_contract_1', status: 'in_progress' },
    },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_contract_1',
        status: 'completed',
        output: [item],
        usage: usage(usageOver),
      },
    },
  ]);
}

async function runSimple(
  context: Context,
  requests: CapturedRequest[],
  options: Record<string, unknown> = {},
  sseBody = textResponseSse('done'),
) {
  const models = await createLoomPiModels();
  const model = models.getModel('openai', ASTRA_ID);
  if (!model) throw new Error('builtin openai/gpt-6-astra missing');
  const stream = models.streamSimple(model, context, {
    apiKey: API_KEY,
    fetch: fakeFetch(sseBody, requests),
    ...options,
  });
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  const message = (await stream.result()) as AssistantMessage;
  return { message, events };
}

describe('openai/gpt-6-astra — builtin catalog resolution (YUK-1027)', () => {
  it('resolves through the pi builtin openai provider on the openai-responses api', async () => {
    const models = await createLoomPiModels();
    const model = models.getModel('openai', ASTRA_ID);
    expect(model).toBeTruthy();
    expect(model?.api).toBe('openai-responses');
    expect(model?.provider).toBe('openai');
    expect(model?.baseUrl).toBe('https://api.openai.com/v1');
    expect(model?.reasoning).toBe(true);
    expect(model?.input).toEqual(['text', 'image']);
    expect(model?.contextWindow).toBe(272_000);
    expect(model?.maxTokens).toBe(128_000);
    // The loom custom catalog path (anthropic-messages) must NOT serve this
    // model — no PROVIDER_PI_CATALOG_SPECS entry exists for 'openai'.
    expect((model as PiModel<PiApi>).api).not.toBe('anthropic-messages');
  });
});

describe('openai/gpt-6-astra — outbound request contract (YUK-1027)', () => {
  const context: Context = {
    systemPrompt: 'You are a test system prompt.',
    messages: [{ role: 'user', content: '解方程 x^2 - 5x + 6 = 0', timestamp: 1 }],
  };

  it('POSTs to /v1/responses with bearer auth, streaming, store:false', async () => {
    const requests: CapturedRequest[] = [];
    const { message } = await runSimple(context, requests, { reasoning: 'high' });
    expect(message.stopReason).toBe('stop');

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`);

    const body = req.body;
    expect(body.model).toBe(ASTRA_ID);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    // max_output_tokens flows from the builtin model's maxTokens (128000) —
    // no adapter-level field needed; pi clamps it to ≥16 server-side minimum.
    expect(body.max_output_tokens).toBe(128_000);
  });

  it('sends no unsupported sampling parameters (temperature/top_p/logprobs)', async () => {
    const requests: CapturedRequest[] = [];
    await runSimple(context, requests, { reasoning: 'high' });
    const body = requests[0].body;
    for (const key of [
      'temperature',
      'top_p',
      'top_logprobs',
      'top_k',
      'frequency_penalty',
      'presence_penalty',
      'samplingParams',
      'max_tokens',
    ]) {
      expect(key in body, `payload must not carry ${key}`).toBe(false);
    }
    // The opencode-go session header must not leak onto the OpenAI lane.
    expect(requests[0].headers['x-opencode-session']).toBeUndefined();
  });

  it('clamps an explicit tiny maxTokens to the Responses ≥16 floor', async () => {
    const requests: CapturedRequest[] = [];
    await runSimple(context, requests, { reasoning: 'low', maxTokens: 5 });
    // streamSimple resolves options.maxTokens (5) → the driver clamps to
    // OPENAI_RESPONSES_MIN_OUTPUT_TOKENS=16 before sending (pi#6265).
    expect(requests[0].body.max_output_tokens).toBe(16);
  });

  it('maps explicit effort onto reasoning.effort and requests encrypted content', async () => {
    for (const [effort, expected] of [
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['xhigh', 'xhigh'],
      ['max', 'max'],
    ] as const) {
      const requests: CapturedRequest[] = [];
      await runSimple(context, requests, { reasoning: effort });
      expect(requests[0].body.reasoning).toEqual({ effort: expected, summary: 'auto' });
      // Encrypted reasoning items enable stateless store:false replay.
      expect(requests[0].body.include).toEqual(['reasoning.encrypted_content']);
    }
  });

  it('documents the no-effort wire shape: no reasoning field at all (endpoint default applies)', async () => {
    const requests: CapturedRequest[] = [];
    await runSimple(context, requests);
    // thinkingLevelMap.off is null for astra → the driver's `off !== null`
    // guard skips the reasoning branch entirely rather than sending
    // effort:'none'. profile.defaultEffort is metadata-only upstream, so the
    // adapter must pass an explicit effort to put reasoning on the wire.
    expect('reasoning' in requests[0].body).toBe(false);
    expect('include' in requests[0].body).toBe(false);
  });

  it('puts the system prompt on a developer message (reasoning model)', async () => {
    const requests: CapturedRequest[] = [];
    await runSimple(context, requests, { reasoning: 'medium' });
    const input = requests[0].body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ role: 'developer' });
    expect(JSON.stringify(input[0])).toContain('test system prompt');
    // user text arrives as input_text
    expect(input[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'input_text', text: '解方程 x^2 - 5x + 6 = 0' }],
    });
  });
});

describe('openai/gpt-6-astra — content round-trips (YUK-1027)', () => {
  it('round-trips a text turn and maps usage incl. cache buckets + tiered cost', async () => {
    const requests: CapturedRequest[] = [];
    const { message } = await runSimple(
      { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
      requests,
      { reasoning: 'low' },
      textResponseSse('答案是 x = 2 或 x = 3'),
    );

    expect(message.role).toBe('assistant');
    expect(message.provider).toBe('openai');
    expect(message.api).toBe('openai-responses');
    expect(message.responseId).toBe('resp_contract_1');
    expect(assistantText(message)).toBe('答案是 x = 2 或 x = 3');
    // cached + cache-write tokens are subtracted OUT of ordinary input.
    const usageOut = message.usage as Usage;
    expect(usageOut.input).toBe(700);
    expect(usageOut.cacheRead).toBe(200);
    expect(usageOut.cacheWrite).toBe(100);
    expect(usageOut.output).toBe(50);
    // Catalog-rate estimate: (700*10 + 50*50 + 200*1 + 100*12.5) / 1e6.
    expect(usageOut.cost.total).toBeCloseTo(0.01095, 8);
  });

  it('applies the >272k input tier when the three input buckets cross it', async () => {
    const requests: CapturedRequest[] = [];
    const { message } = await runSimple(
      { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
      requests,
      {},
      textResponseSse('tiered', {
        input_tokens: 272_001,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 272_101,
      }),
    );
    const usageOut = message.usage as Usage;
    // Tier boundary: 272001 > 272000 → input 20/M, output 75/M.
    expect(usageOut.cost.input).toBeCloseTo((272_001 * 20) / 1e6, 8);
    expect(usageOut.cost.output).toBeCloseTo((100 * 75) / 1e6, 8);
  });

  it('serializes image input as input_image data URLs', async () => {
    const requests: CapturedRequest[] = [];
    await runSimple(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看图回答：' },
              { type: 'image', data: 'aGVsbG8taW1hZ2U=', mimeType: 'image/png' },
            ],
            timestamp: 1,
          },
        ],
      },
      requests,
      { reasoning: 'low' },
    );
    const input = requests[0].body.input as Array<Record<string, unknown>>;
    const userMsg = input[0];
    const content = userMsg.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'input_text', text: '看图回答：' });
    expect(content[1]).toMatchObject({
      type: 'input_image',
      image_url: 'data:image/png;base64,aGVsbG8taW1hZ2U=',
    });
  });

  it('round-trips function tools: function_call ⇄ toolCall ⇄ function_call_output (call_id split)', async () => {
    const requests: CapturedRequest[] = [];
    const tool: Tool = {
      name: 'mcp__math__solve',
      description: 'Solve a math problem',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
    } as unknown as Tool;
    const toolSse = sse([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_0001',
          call_id: 'call_abc123',
          name: 'mcp__math__solve',
          arguments: '',
          status: 'in_progress',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'fc_0001',
        delta: '{"q":"x^2',
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc_0001',
        arguments: '{"q":"x^2-5x+6=0"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_0001',
          call_id: 'call_abc123',
          name: 'mcp__math__solve',
          arguments: '{"q":"x^2-5x+6=0"}',
          status: 'completed',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_contract_tool',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_0001',
              call_id: 'call_abc123',
              name: 'mcp__math__solve',
              arguments: '{"q":"x^2-5x+6=0"}',
              status: 'completed',
            },
          ],
          usage: usage(),
        },
      },
    ]);

    const { message } = await runSimple(
      {
        messages: [{ role: 'user', content: '调用工具解题', timestamp: 1 }],
        tools: [tool],
      },
      requests,
      { reasoning: 'high' },
      toolSse,
    );

    // Outbound tools array uses Responses 'function' items.
    const body = requests[0].body;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: 'function', name: 'mcp__math__solve' });

    // Inbound toolCall id carries the call_id|item_id composite.
    const toolCall = message.content.find((b) => b.type === 'toolCall');
    expect(toolCall).toMatchObject({
      id: 'call_abc123|fc_0001',
      name: 'mcp__math__solve',
      arguments: { q: 'x^2-5x+6=0' },
    });
    expect(message.stopReason).toBe('toolUse');

    // Turn 2 — replay the SAME provider/api assistant message + the tool
    // result; the outbound payload must pair function_call_output.call_id
    // with the split call_id (no composite id on the wire).
    const toolResult = {
      role: 'toolResult' as const,
      toolCallId: 'call_abc123|fc_0001',
      toolName: 'mcp__math__solve',
      content: [{ type: 'text' as const, text: 'x=2 或 x=3' }],
      isError: false,
      timestamp: 2,
    };
    await runSimple(
      {
        messages: [
          { role: 'user', content: '调用工具解题', timestamp: 1 },
          message,
          toolResult,
          { role: 'user', content: '继续', timestamp: 3 },
        ],
        tools: [tool],
      },
      requests,
      { reasoning: 'high' },
      textResponseSse('基于工具结果：x=2 或 x=3'),
    );

    const secondInput = requests[1].body.input as Array<Record<string, unknown>>;
    const fnCall = secondInput.find((i) => i.type === 'function_call');
    const fnOut = secondInput.find((i) => i.type === 'function_call_output');
    expect(fnCall).toMatchObject({
      call_id: 'call_abc123',
      name: 'mcp__math__solve',
      arguments: '{"q":"x^2-5x+6=0"}',
    });
    // Same-provider same-model replay keeps the fc_* item id for pairing.
    expect(fnCall?.id).toBe('fc_0001');
    expect(fnOut).toMatchObject({ call_id: 'call_abc123' });
    expect(JSON.stringify(secondInput)).not.toContain('call_abc123|fc_0001');
  });
});

describe('openai/gpt-6-astra — cross-model replay hygiene (YUK-1027)', () => {
  it('strips foreign-provider signatures and re-keys foreign toolCall ids', async () => {
    const requests: CapturedRequest[] = [];
    // A MiMo (xiaomi / anthropic-messages) assistant turn carried over a
    // session switch: thinkingSignature/thoughtSignature must not reach the
    // Responses payload, and the tool result still pairs by call_id.
    const foreignAssistant: AssistantMessage = {
      role: 'assistant',
      provider: 'xiaomi',
      api: 'anthropic-messages',
      model: 'mimo-v2.5-pro',
      content: [
        {
          type: 'thinking',
          thinking: 'mimo 私密推理',
          thinkingSignature: '{"anthropic_sig":"abc"}',
        },
        { type: 'text', text: '先前答案', textSignature: 'sig_text' },
        {
          type: 'toolCall',
          id: 'callu_9f8e7d',
          name: 'mcp__math__solve',
          arguments: { q: 'x' },
          thoughtSignature: 'foreign_tool_sig',
        },
      ],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: 1,
    } as unknown as AssistantMessage;
    await runSimple(
      {
        messages: [
          { role: 'user', content: '早先的题', timestamp: 0 },
          foreignAssistant,
          {
            role: 'toolResult',
            toolCallId: 'callu_9f8e7d',
            toolName: 'mcp__math__solve',
            content: [{ type: 'text', text: '工具结果' }],
            isError: false,
            timestamp: 2,
          },
          { role: 'user', content: '继续', timestamp: 3 },
        ],
      },
      requests,
      { reasoning: 'high' },
    );
    const input = requests[0].body.input as Array<Record<string, unknown>>;
    const raw = JSON.stringify(input);
    // No foreign signatures / reasoning items cross the model boundary.
    expect(input.every((i) => i.type !== 'reasoning')).toBe(true);
    expect(raw).not.toContain('anthropic_sig');
    expect(raw).not.toContain('foreign_tool_sig');
    expect(raw).not.toContain('sig_text');
    // The foreign toolCall still pairs: function_call + output share call_id.
    const fnCall = input.find((i) => i.type === 'function_call');
    const fnOut = input.find((i) => i.type === 'function_call_output');
    expect(fnCall).toMatchObject({ call_id: 'callu_9f8e7d', name: 'mcp__math__solve' });
    expect(fnOut).toMatchObject({ call_id: 'callu_9f8e7d' });
    // The stripped thinking survives as plain text history.
    expect(raw).toContain('mimo 私密推理');
  });
});

describe('openai/gpt-6-astra — abort + error honesty (YUK-1027)', () => {
  it('forwards the caller AbortSignal through to fetch (composed by the SDK)', async () => {
    const requests: CapturedRequest[] = [];
    const controller = new AbortController();
    await runSimple({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }, requests, {
      signal: controller.signal,
    });
    // The OpenAI SDK composes the caller signal with its own timeout
    // controller, so the fetch-level signal is a distinct object — assert the
    // abort still propagates rather than object identity.
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    expect(requests[0].signal?.aborted).toBe(false);
    controller.abort();
    expect(requests[0].signal?.aborted).toBe(true);
  });

  it('an already-aborted signal fails in auth setup before any fetch — honest error, not success', async () => {
    const requests: CapturedRequest[] = [];
    const controller = new AbortController();
    controller.abort();
    const { events } = await runSimple(
      { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
      requests,
      { signal: controller.signal },
      textResponseSse('should not be consumed'),
    );
    // resolveProviderAuth calls signal.throwIfAborted() → lazyStream's setup
    // catch terminates the stream with a setup error (stopReason 'error',
    // errorMessage carrying the abort reason). Fetch is never invoked and no
    // fake 'done' is synthesized — cancellation remains an honest failure.
    expect(requests).toHaveLength(0);
    const terminal = events.at(-1) as {
      type: string;
      error?: { stopReason?: string; errorMessage?: string };
    };
    expect(terminal.type).toBe('error');
    expect(terminal.error?.stopReason).toBe('error');
    expect(terminal.error?.errorMessage).toMatch(/abort/i);
  });

  it('surfaces a non-retryable HTTP error as an error event with provider detail', async () => {
    const requests: CapturedRequest[] = [];
    const models = await createLoomPiModels();
    const model = models.getModel('openai', ASTRA_ID);
    if (!model) throw new Error('missing model');
    const failingFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const rawBody = init?.body ?? request.body;
      const bodyText = typeof rawBody === 'string' ? rawBody : await request.text();
      requests.push({
        url: request.url,
        method: request.method,
        headers: {},
        body: JSON.parse(bodyText),
        signal: init?.signal ?? request.signal,
      });
      return new Response(JSON.stringify({ error: { message: 'invalid api key', type: 'auth' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    };
    const stream = models.streamSimple(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
      { apiKey: API_KEY, fetch: failingFetch, maxRetries: 0 },
    );
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    const terminal = events.at(-1) as {
      type: string;
      error?: { stopReason?: string; errorMessage?: string };
    };
    expect(terminal.type).toBe('error');
    expect(terminal.error?.stopReason).toBe('error');
    expect(terminal.error?.errorMessage).toContain('invalid api key');
  });
});

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
