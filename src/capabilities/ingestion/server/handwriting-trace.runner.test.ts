import { agentLoop } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  type Model,
  createAssistantMessageEventStream,
  createModels,
} from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the provider's wire call is scripted. The real runTask runner packing, the
// real pi adapter and the real agent loop all execute; the fake DB is never touched
// because the task-run log writers are mocked.
vi.mock('@/server/ai/log', () => ({
  logMissingToolMountsWarning: vi.fn(),
  writeAiTaskRunStarted: vi.fn(async () => {}),
  writeAiTaskRunFinished: vi.fn(async () => {}),
  writeAiTaskRunRetried: vi.fn(async () => true),
  writeCostLedger: vi.fn(async () => {}),
  writeAiTaskAttemptFinished: vi.fn(async () => true),
}));

import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { runHandwritingTrace } from './handwriting-trace';
import { runStructureTask } from './structure';

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

function assistant(text: string): AssistantMessage {
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
    stopReason: 'stop',
  };
}

/** Installs a real adapter whose provider stream returns the next scripted text. */
function installAdapter(responses: string[]): {
  providerMessages: AssistantMessage['content'][number][][];
} {
  const captured: AssistantMessage['content'][number][][] = [];
  const models = createModels();
  vi.spyOn(models, 'getModel').mockReturnValue(model);
  vi.spyOn(models, 'streamSimple').mockImplementation((_m, context) => {
    const user = [...context.messages].reverse().find((message) => message.role === 'user');
    captured.push((user?.content ?? []) as AssistantMessage['content'][number][]);
    const text = responses.shift();
    if (text === undefined) throw new Error('offline script exhausted');
    const message = assistant(text);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  });
  __setPiAdapterForTests(new PiAgentAdapter({ models, agentLoop }));
  return { providerMessages: captured };
}

function imageCount(content: readonly unknown[]): number {
  return content.filter(
    (block) =>
      typeof block === 'object' && block !== null && 'type' in block && block.type === 'image',
  ).length;
}

describe('multimodal tasks reach the provider with their page images', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCODE_API_KEY', 'sk-test-key');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'opencode-go');
    vi.stubEnv('AI_PROVIDER_MODEL', 'deepseek-v4.1-flash');
  });
  afterEach(() => {
    __setPiAdapterForTests(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // @invariant data: handwriting evidence must come from page images the provider actually receives
  // @fails-if runHandwritingTrace passes bare text so the provider gets zero image blocks, letting the model invent per-question traces
  it('sends every page image to the provider for HandwritingTraceTask', async () => {
    const { providerMessages } = installAdapter([
      JSON.stringify({
        traces: [
          { leaf_index: 0, text: '42', red_mark: 'check', confidence: 0.9 },
          { leaf_index: 1, text: '4', red_mark: 'cross', confidence: 0.8 },
        ],
        unresolved: [],
      }),
    ]);
    const result = await runHandwritingTrace({
      pageImages: [
        { data: pageImage, mediaType: 'image/png' },
        { data: pageImage, mediaType: 'image/png' },
      ],
      pageCount: 2,
      leaves: [
        { index: 0, page_index: 0, question_no: '1', prompt_text: '7 x 6 =' },
        { index: 1, page_index: 1, question_no: '2', prompt_text: '12 / 3 =' },
      ],
      db: fakeDb,
    });
    expect(result.traces).toHaveLength(2);
    expect(providerMessages).toHaveLength(1);
    const content = providerMessages[0] ?? [];
    expect(imageCount(content)).toBe(2);
    expect(content.some((block) => block.type === 'text')).toBe(true);
  });

  // @invariant data: the pre-existing StructureTask multimodal input also survives the real runner packing
  // @fails-if StructureTask reaches the provider without its page images or its text hint
  it('sends every page image to the provider for StructureTask', async () => {
    const { providerMessages } = installAdapter([
      JSON.stringify({
        layout_quality: 'structured',
        extraction_confidence: 0.9,
        warnings: [],
        questions: [{ role: 'standalone', prompt_text: '1 + 1 = ?', page_index: 0 }],
      }),
    ]);
    const result = await runStructureTask({
      pageImages: [
        { data: pageImage, mediaType: 'image/png' },
        { data: pageImage, mediaType: 'image/png' },
      ],
      tencentHintMd: '=== page 0 ===\n1 + 1 = ?',
      pageCount: 2,
      db: fakeDb,
    });
    expect(result.questions).toHaveLength(1);
    expect(providerMessages).toHaveLength(1);
    const content = providerMessages[0] ?? [];
    expect(imageCount(content)).toBe(2);
    expect(content.some((block) => block.type === 'text')).toBe(true);
  });
});
