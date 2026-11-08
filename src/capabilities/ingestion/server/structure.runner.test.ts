import { agentLoop } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  type Model,
  createAssistantMessageEventStream,
  createModels,
} from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the provider's wire call is scripted. The real runTask packing, the real pi
// adapter, the real agent loop and the real lifecycle timer all execute; the fake
// DB is never touched because the task-run log writers are mocked.
vi.mock('@/server/ai/log', () => ({
  logMissingToolMountsWarning: vi.fn(),
  writeAiTaskRunStarted: vi.fn(async () => {}),
  writeAiTaskRunFinished: vi.fn(async () => {}),
  writeAiTaskRunRetried: vi.fn(async () => true),
  writeCostLedger: vi.fn(async () => {}),
  writeAiTaskAttemptFinished: vi.fn(async () => true),
  markAiTaskRunOutputInvalid: vi.fn(async () => true),
}));

import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { StructureTaskError } from '../tasks/structure';
import { runStructureTask } from './structure';

const STRUCTURE_TIMEOUT_MS = 300_000;
const fakeDb = {} as never;
const pageImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
).toString('base64');

const model: Model<'openai-completions'> = {
  id: 'deepseek-v4.1-flash',
  name: 'Offline Flash',
  provider: 'opencode-go',
  api: 'openai-completions',
  reasoning: false,
  baseUrl: 'https://offline.invalid',
  input: ['text', 'image'],
  contextWindow: 10000,
  maxTokens: 100,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
};

function message(text: string, stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
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

type ProviderCall = { systemPrompt: string; timeoutMs: number | undefined };

/** A provider that never answers until its request signal aborts. */
function installHungProvider(): { reached: Promise<ProviderCall> } {
  let resolveReached: (call: ProviderCall) => void = () => {};
  const reached = new Promise<ProviderCall>((resolve) => {
    resolveReached = resolve;
  });
  const models = createModels();
  vi.spyOn(models, 'getModel').mockReturnValue(model);
  vi.spyOn(models, 'streamSimple').mockImplementation((_m, context, options) => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message('', 'pending') });
    options?.signal?.addEventListener(
      'abort',
      () => stream.push({ type: 'error', reason: 'aborted', error: message('', 'aborted') }),
      { once: true },
    );
    resolveReached({ systemPrompt: context.systemPrompt ?? '', timeoutMs: options?.timeoutMs });
    return stream;
  });
  __setPiAdapterForTests(new PiAgentAdapter({ models, agentLoop }));
  return { reached };
}

describe('StructureTask through the real runner', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCODE_API_KEY', 'sk-test-key');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'opencode-go');
    vi.stubEnv('AI_PROVIDER_MODEL', 'deepseek-v4.1-flash');
  });
  afterEach(() => {
    vi.useRealTimers();
    __setPiAdapterForTests(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // @invariant concurrency: a hung StructureTask call is cut at its own measured-tail bound, not the 120s default that real pages already approach
  // @fails-if StructureTask falls back to the 120s default budget, or the lifecycle timer is never armed so a hung provider holds the OCR job open
  it('aborts a hung call at 300s, with the transcription rules on the wire', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { reached } = installHungProvider();
    const settled = runStructureTask({
      pageImages: [{ data: pageImage, mediaType: 'image/png' }],
      tencentHintMd: '=== page 0 ===\n1. 2 + 3 = ___',
      pageCount: 1,
      db: fakeDb,
    }).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    const call = await reached;
    expect(call.systemPrompt).toContain('手写和批改痕迹不是题面');
    expect(call.systemPrompt).toContain('分节标题不是题');
    expect(call.systemPrompt).toContain('不拼大题号');
    expect(call.systemPrompt).toContain('可选字段没有值就省略这个键');
    expect(call.timeoutMs).toBe(STRUCTURE_TIMEOUT_MS + 15_000);

    await vi.advanceTimersByTimeAsync(STRUCTURE_TIMEOUT_MS - 1);
    const early = await Promise.race([settled, Promise.resolve('pending' as const)]);
    expect(early).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toBeInstanceOf(StructureTaskError);
  });
});
